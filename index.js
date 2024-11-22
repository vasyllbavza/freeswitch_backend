const express = require('express');
const multer = require('multer');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const path = require('path');

dotenv.config();

const app = express();
const port = 7001;

const upload = multer({ dest: 'uploads/' });

app.use(express.json());

// Asynchronous function to transcribe audio using Deepgram API
async function transcribeAudio(filePath) {
  try {
    const audioData = await fs.readFile(filePath);
    const response = await axios.post('https://api.deepgram.com/v1/listen', audioData, {
      headers: {
        'Content-Type': 'audio/wav',
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });
    return response.data.results.channels[0].alternatives[0].transcript;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    return '';
  }
}

// Asynchronous function to generate a response using OpenAI API
async function generateResponse(callUuid, text, agentId) {
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
    console.error('Error generating response:', error);
    return '';
  }
}

// Asynchronous function to convert text to speech using Google's TTS API
async function textToSpeech(text) {
  try {
    const response = await axios.post(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
      input: { text },
      voice: { languageCode: 'en-US', name: 'en-US-Wavenet-A', ssmlGender: 'MALE' },
      audioConfig: { audioEncoding: 'LINEAR16' }
    });
    return Buffer.from(response.data.audioContent, 'base64');
  } catch (error) {
    console.error('Error in text-to-speech:', error);
    return null;
  }
}

async function textToSpeech2(text) {
  try {
    const response = await axios.post('https://api.elevenlabs.io/v1/text-to-speech', {
      text: text,
      voice: 'en_us_male',  // Replace with the voice options provided by ElevenLabs
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
    console.error('Error in text-to-speech with ElevenLabs:', error);
    return null;
  }
}
// Endpoint to handle audio processing
app.post('/vocodeApi', upload.single('file'), async (req, res) => {
  const { callUuid, callTo } = req.body;
  const filePath = req.file.path;
  try {
    const transcript = await transcribeAudio(filePath);
    console.log("\n------------------------------------Input------------------------------------\n", transcript);

    if (!transcript && filePath) {
      console.error("Transcript is empty or file path is empty, skipping text-to-speech conversion.");
      return res.status(400).send({ error: 'Transcript is empty' });
    }

    const responseText = await generateResponse(callUuid, transcript, callTo);
    console.log("------------------------------------Output----------------------------------\n", responseText, "\n----------------------------------------------------------------------------");

    const audioResponse = await textToSpeech2(responseText);
    if (!audioResponse) {
      console.error("Audio response is empty, skipping save.");
      return res.status(500).send({ error: 'Failed to generate audio response' });
    }

    const responseDir = path.join(__dirname, 'recordings');
    await fs.ensureDir(responseDir);

    const responseFilePath = path.join(responseDir, `${callUuid}_response.wav`);
    await fs.writeFile(responseFilePath, audioResponse);

    // Set permissions to read by everyone
    fs.chmodSync(responseFilePath, 0o777);

    res.send({ message: 'Call details received, processing completed.', path: responseFilePath });
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send({ error: 'Internal server error' });
  } finally {
    // Clean up uploaded file
    fs.unlinkSync(filePath);
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});