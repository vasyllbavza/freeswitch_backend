const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const axios = require("axios");
const { Pinecone } = require("@pinecone-database/pinecone");
const OpenAI = require("openai");
require("dotenv").config();

// Environment Variables
const PORT = process.env.PORT || 8000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENVIRONMENT = process.env.PINECONE_ENVIRONMENT;
const PINECONE_INDEX_NAME = "conversation-history";

// Initialize Deepgram, OpenAI, and Pinecone Clients
const deepgram = createClient(DEEPGRAM_API_KEY);  
const openai = new OpenAI(OPENAI_API_KEY);

// Initialize Pinecone client
const pinecone = new Pinecone({
    apiKey: PINECONE_API_KEY, // Your Pinecone API key
    // environment: PINECONE_ENVIRONMENT, // Your Pinecone environment (e.g., "us-east1-gcp")
});

const pineconeIndex = pinecone.Index(PINECONE_INDEX_NAME);

// Initialize Express and WebSocket server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket Connection Handling
wss.on("connection", (ws) => {
  console.log("New client connected.");

  let callId = null; // Unique identifier for the call
  let agentRole = "You are a helpful assistant."; // Default agent role

  // Handle metadata sent from FreeSWITCH (e.g., call_id and agent role)
  ws.on("message", (message) => {
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);

        if (data.call_id) {
          callId = data.call_id; // Assign the unique call ID
          console.log(`Call ID assigned: ${callId}`);
        }

        if (data.agent) {
          if (data.agent === "technical") {
            agentRole = "You are a technical support assistant specializing in troubleshooting.";
          } else if (data.agent === "sales") {
            agentRole = "You are a sales representative who provides product information.";
          } else {
            agentRole = "You are a general helpful assistant.";
          }
          console.log(`Agent role assigned: ${agentRole}`);
        }
      } catch (err) {
        console.error("Error parsing JSON metadata from client:", err);
      }
    }
  });

  // Create a Deepgram streaming connection
  const dgSocket = deepgram.transcription.live({
    punctuate: true,
    interim_results: true,
  });

  // Handle audio chunks from FreeSWITCH
  ws.on("message", (audioChunk) => {
    if (Buffer.isBuffer(audioChunk)) {
      dgSocket.send(audioChunk); // Send audio to Deepgram for transcription
    }
  });

  // Handle transcription results from Deepgram
  dgSocket.on("transcript", async (data) => {
    const transcript = data.channel.alternatives[0]?.transcript || "";

    if (transcript.length > 0) {
      if (data.is_final) {
        console.log("Final Transcript:", transcript);

        const response = await processTranscriptionWithContext(transcript, ws, agentRole, callId);

        // Store the final transcript and response in Pinecone
        await storeInPinecone(callId, transcript, response);
      } else {
        console.log("Interim Transcript:", transcript);
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected.");
    dgSocket.finish();
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    dgSocket.finish();
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on ws://localhost:${PORT}`);
});

// Process transcription and generate AI response
async function processTranscriptionWithContext(transcript, ws, agentRole, callId) {
  try {
    const context = await retrieveContextFromPinecone(transcript, callId);

    const messages = [
      { role: "system", content: agentRole },
      ...context.map((item) => ({
        role: item.role,
        content: item.text,
      })),
      { role: "user", content: transcript },
    ];

    const response = await openai.createChatCompletion(
      {
        model: "gpt-4o-2024-11-20",
        messages,
        stream: true,
      },
      { responseType: "stream" }
    );

    let fullResponse = "";

    response.data.on("data", (chunk) => {
      const lines = chunk
        .toString()
        .split("\n")
        .filter((line) => line.trim() !== "");

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const json = line.replace(/^data: /, "");
          if (json === "[DONE]") {
            ws.send("[DONE]");
            return;
          }

          try {
            const parsed = JSON.parse(json);
            const token = parsed.choices[0]?.delta?.content || "";
            if (token) {
              fullResponse += token;
              ws.send(token);
            }
          } catch (err) {
            console.error("Error parsing AI response:", err);
          }
        }
      }
    });

    response.data.on("end", async () => {
      await streamTTS(fullResponse, ws);
    });

    return fullResponse;
  } catch (error) {
    console.error("Error during transcription processing:", error);
    ws.send("Error occurred while generating a response.");
  }
}

// Stream TTS audio using ElevenLabs
async function streamTTS(text, ws) {
  try {
    const response = await axios.post(
      "https://api.elevenlabs.io/v1/text-to-speech/stream",
      {
        text,
        voice_settings: { stability: 0.75, similarity_boost: 0.8 },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        responseType: "stream",
      }
    );

    response.data.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk); // Stream audio chunks to FreeSWITCH
      }
    });

    response.data.on("end", () => {
      ws.send("[TTS_DONE]");
    });
  } catch (error) {
    console.error("Error in TTS generation:", error.response?.data || error);
  }
}

// Store transcription and response in Pinecone
async function storeInPinecone(callId, transcription, response) {
  const transcriptionEmbedding = await generateEmbedding(transcription);
  const responseEmbedding = await generateEmbedding(response);

  await pineconeIndex.upsert([
    { id: `transcription-${callId}-${Date.now()}`, values: transcriptionEmbedding, metadata: { text: transcription, role: "user", call_id: callId } },
    { id: `response-${callId}-${Date.now()}`, values: responseEmbedding, metadata: { text: response, role: "assistant", call_id: callId } },
  ]);
}

// Retrieve context from Pinecone
async function retrieveContextFromPinecone(query, callId) {
  const queryEmbedding = await generateEmbedding(query);

  const result = await pineconeIndex.query({
    vector: queryEmbedding,
    topK: 5,
    includeMetadata: true,
    filter: { call_id: callId }, // Filter results by call ID
  });

  return result.matches.map((match) => match.metadata);
}

// Generate embedding with OpenAI
async function generateEmbedding(text) {
  const response = await openai.createEmbedding({
    model: "text-embedding-ada-002",
    input: text,
  });
  return response.data.data[0].embedding;
}