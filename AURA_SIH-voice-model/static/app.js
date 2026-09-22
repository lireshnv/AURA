document.addEventListener('DOMContentLoaded', () => {
    const chatBox = document.getElementById('chat-box');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const recordBtn = document.getElementById('record-btn');
    const recordingStatus = document.getElementById('recording-status');
    
    let chatHistory = [];
    
    // Audio recording setup
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;

    // Initialize MediaRecorder
    async function setupAudio() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                
                mediaRecorder.ondataavailable = (e) => {
                    audioChunks.push(e.data);
                };
                
                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = []; // reset
                    await transcribeAudio(audioBlob);
                };
            } catch (err) {
                console.error("Microphone access denied or failed.", err);
            }
        }
    }
    setupAudio();

    // Toggle recording
    recordBtn.addEventListener('click', () => {
        if (!mediaRecorder) {
            alert("Microphone not accessible. Please ensure you have granted permission.");
            return;
        }

        if (!isRecording) {
            // Start recording
            mediaRecorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
            recordingStatus.classList.remove('hidden');
        } else {
            // Stop recording
            mediaRecorder.stop();
            isRecording = false;
            recordBtn.classList.remove('recording');
            recordingStatus.classList.add('hidden');
        }
    });

    async function transcribeAudio(audioBlob) {
        // Show loading in textarea
        const originalPlaceholder = messageInput.placeholder;
        messageInput.placeholder = "Transcribing...";
        
        const formData = new FormData();
        // create a File from the Blob
        const audioFile = new File([audioBlob], "voice_msg.webm", { type: 'audio/webm' });
        formData.append("audio", audioFile);
        
        try {
            const response = await fetch('/api/transcribe', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (response.ok && data.text) {
                // Append text to the input box so user can read/edit before sending
                messageInput.value = (messageInput.value + " " + data.text).trim();
            } else {
                console.error("Transcription error", data);
                alert("Failed to transcribe audio.");
            }
        } catch (err) {
            console.error("Error sending audio to backend", err);
        } finally {
            messageInput.placeholder = originalPlaceholder;
        }
    }

    function addMessageToUI(text, isUser) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${isUser ? 'user-message' : 'aura-message'}`;
        
        if (isUser) {
            msgDiv.textContent = text;
        } else {
            msgDiv.innerHTML = marked.parse(text);
        }
        
        chatBox.appendChild(msgDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    async function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        
        // Add to UI
        addMessageToUI(text, true);
        messageInput.value = '';
        
        // Show loading indicator
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingDiv.textContent = 'AURA is typing...';
        chatBox.appendChild(loadingDiv);
        chatBox.scrollTop = chatBox.scrollHeight;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: text, history: chatHistory })
            });
            
            chatBox.removeChild(loadingDiv);
            
            if (response.ok) {
                const data = await response.json();
                const auraResponse = data.response;
                
                // Add to history
                chatHistory.push({ role: "user", content: text });
                chatHistory.push({ role: "assistant", content: auraResponse });
                
                // Add to UI
                addMessageToUI(auraResponse, false);
            } else {
                let errorMsg = "Unknown error";
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.detail || errorMsg;
                } catch(e) {}
                console.error("Backend Error:", errorMsg);
                addMessageToUI(`I'm sorry, I encountered an error: ${errorMsg}`, false);
            }
        } catch (err) {
            chatBox.removeChild(loadingDiv);
            addMessageToUI("Connection error. Please try again later.", false);
            console.error(err);
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
});
