const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const path = require('path');

dotenv.config();

const app = express();
const port = process.env.PORT || 7001;

app.use(express.json());

// Store states for each call
const callStates = {};

// Function to generate a response using OpenAI API
async function generateResponse(callId, text, agentId) {
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: text }],
      max_tokens: 150,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error(`Error generating response for callId ${callId}:`, error);
    return '';
  }
}

// Function to convert text to speech using ElevenLabs TTS API
async function textToSpeechWithElevenLabs(callId, text) {
  try {
    const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech', {
      text: text,
      voice: 'en_us_male',  // Replace with the correct voice options provided by ElevenLabs
      speed: 1.0  // Adjust speed as needed
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'  // Set response type to arraybuffer to handle audio data
    });
    return Buffer.from(response.data);  // Return the audio buffer directly
  } catch (error) {
    console.error(`Error in text-to-speech with ElevenLabs for callId ${callId}:`, error);
    return null;
  }
}

// Endpoint to process text requests
app.post('/vocodeApi', async (req, res) => {
  const { callId, inputText, callTo } = req.body;
  if (!inputText) {
    return res.status(400).send({ error: 'Input text is empty' });
  }

  // Initialize call state
  callStates[callId] = { status: 'processing', error: null };

  try {
    console.log(`Processing callId ${callId} with input:`, inputText);

    const responseText = await generateResponse(callId, inputText, callTo);
    console.log(`Generated response for callId ${callId}:`, responseText);

    const audioResponse = await textToSpeechWithElevenLabs(callId, responseText);
    if (!audioResponse) {
      throw new Error('Failed to generate audio response');
    }

    const responseDir = path.join(__dirname, 'recordings');
    await fs.ensureDir(responseDir);

    const responseFilePath = path.join(responseDir, `${callId}_response.wav`);
    await fs.writeFile(responseFilePath, audioResponse);

    // Set permissions to read by everyone
    fs.chmodSync(responseFilePath, 0o777);

    // Update call state
    callStates[callId] = { status: 'completed', path: responseFilePath };

    res.send({ message: 'Text processed and audio generated.', path: responseFilePath });
  } catch (error) {
    console.error(`Error processing callId ${callId}:`, error);
    callStates[callId] = { status: 'error', error: error.message };
    res.status(500).send({ error: 'Internal server error' });
  }
});

// Endpoint to check the status of a call
app.get('/callStatus/:callId', (req, res) => {
  const { callId } = req.params;
  const callState = callStates[callId];

  if (!callState) {
    return res.status(404).send({ error: 'Call ID not found' });
  }

  res.send(callState);
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});