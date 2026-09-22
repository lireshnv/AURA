import os
import json
# pyrefly: ignore [missing-import]
from groq import Groq
from duckduckgo_search import DDGS

# Tool definition for Groq
web_search_tool = {
    "type": "function",
    "function": {
        "name": "search_web",
        "description": "Searches the web for information using DuckDuckGo. Use this tool when the user asks for factual information, NGOs, legal rights, or anything that requires up-to-date knowledge from the internet.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to look up on the internet."
                }
            },
            "required": ["query"]
        }
    }
}

def perform_web_search(query: str) -> str:
    """Uses duckduckgo-search to find answers online."""
    try:
        results = DDGS().text(query, max_results=3)
        if not results:
            return "No relevant information found on the web."
        
        # Format the results
        formatted_results = "\n\n".join([f"Title: {res['title']}\nSnippet: {res['body']}\nURL: {res['href']}" for res in results])
        return formatted_results
    except Exception as e:
        return f"Error during web search: {str(e)}"

def get_groq_client():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY environment variable not set")
    return Groq(api_key=api_key)

def chat_with_aura(message: str, history: list = None):
    """
    history: list of dicts with 'role' and 'content'
    """
    if history is None:
        history = []
        
    client = get_groq_client()
    
    # Read the prompt dynamically so changes are reflected immediately
    prompt_file = os.path.join(os.path.dirname(__file__), "system_prompt.md")
    with open(prompt_file, "r", encoding="utf-8") as f:
        system_prompt = f.read()
    
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": message})
    
    # First API call to Groq
    response = client.chat.completions.create(
        model="openai/gpt-oss-120b", # Or another appropriate Groq model
        messages=messages,
        tools=[web_search_tool],
        tool_choice="auto",
        max_tokens=1024
    )
    
    response_message = response.choices[0].message
    tool_calls = response_message.tool_calls
    
    # If the model decided to use a tool
    if tool_calls:
        messages.append(response_message) # Append the assistant's tool call message
        
        for tool_call in tool_calls:
            if tool_call.function.name == "search_web":
                function_args = json.loads(tool_call.function.arguments)
                search_query = function_args.get("query")
                
                # Perform the actual web search
                search_result = perform_web_search(search_query)
                
                # Append the tool response to messages
                messages.append({
                    "tool_call_id": tool_call.id,
                    "role": "tool",
                    "name": "search_web",
                    "content": search_result
                })
        
        # Second API call to Groq with tool results
        final_response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=messages,
            max_tokens=1024
        )
        return final_response.choices[0].message.content
        
    return response_message.content

def transcribe_audio(file_path: str):
    """Uses Groq's Whisper model to transcribe audio."""
    client = get_groq_client()
    with open(file_path, "rb") as file:
        transcription = client.audio.transcriptions.create(
            file=(file_path, file.read()),
            model="whisper-large-v3",
            prompt="Transcribe the following audio accurately in English.",
            response_format="text",
            language="en"
        )
    return transcription
