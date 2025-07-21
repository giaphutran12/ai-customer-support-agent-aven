import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Logger } from "@/utils/logger";
import { env } from "@/config/env";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
//import { GoogleGenAI } from "@google/genai";

//////MAIN CODE//////////////////////////////////////////////////////////////////////////////////
const logger = new Logger("API:Chat");

const pc = new Pinecone({ apiKey: env.PINECONE_API_KEY });
const ai = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
const embeddingModel = ai.getGenerativeModel({ model: "gemini-embedding-001" });
const namespace = pc
  .index(
    "company-data",
    "https://company-data-r6bdk7j.svc.aped-4627-b74a.pinecone.io"
  )
  .namespace("aven");

const gemini = new OpenAI({
  apiKey: env.GOOGLE_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

export async function POST(req: NextRequest) {
  if (req.method !== "POST") {
    return NextResponse.json({ message: "Not Found" }, { status: 404 });
  }
  try {
    const body = await req.json();
    // logger.info("Received request body:", {
    //   hasMessage: body.messages.length > 0,
    // });
    const { messages = [], max_tokens, temperature, stream, model } = body;

    // Step 1: Generate a modified prompt using the last user message
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || !lastMessage.content) {
      return NextResponse.json(
        { error: "No last message content provided." },
        { status: 400 }
      );
    }
    const query = lastMessage.content;
    logger.info("Query", query);
    const context = await fetchContextFromPinecone(query);
    logger.info("Context:", context);
    const geminiPrompt = buildGeminiPrompt(context, query);
    const promptPayload = {
      model: "gemini-2.0-flash-lite",
      messages: [
        {
          role: "assistant",
          content: geminiPrompt,
        },
      ] as OpenAI.Chat.ChatCompletionMessageParam[],
      max_tokens: 170,
      temperature: 1.0,
    };
    logger.info("Prompt payload for Gemini", promptPayload);

    const prompt = await gemini.chat.completions.create(promptPayload);
    // Use a type guard to safely access the message property
    let promptChoice = lastMessage.content;
    const messageContent = getMessageContent(prompt);
    if (messageContent) {
      promptChoice = messageContent;
    }

    // Step 2: Prepare the modified messages array
    const modifiedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...messages.slice(0, messages.length - 1),
      { role: lastMessage.role, content: promptChoice },
    ];

    // Step 3: Prepare the completion payload
    const completionPayload = {
      model: "gemini-2.0-flash-lite",
      messages: modifiedMessages,
      max_tokens: max_tokens || 80,
      temperature: temperature || 0.5,
      stream: !!stream,
    };
    logger.info("Completion payload for Gemini", completionPayload);

    // Step 4: Call the Gemini API for completion
    if (stream) {
      // If streaming is not supported, fallback to non-streaming
      try {
        const completionStream = await gemini.chat.completions.create(
          completionPayload as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        );

        // Use helper to return streaming response
        return streamGeminiResponse(completionStream, logger);
      } catch (err) {
        LogStreamingError(err);
        // Fallback to non-streaming
        return await getGeminiCompletion(
          gemini,
          completionPayload,
          logger,
          "Completion result (fallback)"
        );
      }
    } else {
      return await getGeminiCompletion(gemini, completionPayload, logger);
    }
  } catch (e) {
    logger.error("Error in Gemini API call", e);
    return NextResponse.json(
      { error: (e as any)?.message || e },
      { status: 500 }
    );
  }
}
//////END OF MAIN CODE////////////////////////////////////////////////////////////////////////////

// Helper to safely get message content from OpenAI-like response
function getMessageContent(prompt: any): string | undefined {
  return prompt?.choices?.[0]?.message?.content;
}

// Helper to stream Gemini response as SSE
function streamGeminiResponse(
  completionStream: AsyncIterable<any>,
  logger: Logger
): Response {
  // Helper to format and enqueue a chunk as SSE
  function enqueueSSEChunk(
    controller: ReadableStreamDefaultController,
    chunk: any
  ) {
    const data = `data: ${JSON.stringify(chunk)}\n\n`;
    controller.enqueue(new TextEncoder().encode(data));
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of completionStream) {
          enqueueSSEChunk(controller, chunk);
        }
        enqueueSSEChunk(controller, "[DONE]");
        controller.close();
      } catch (error) {
        logger.error("Error in streaming:", error);
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// Helper to fetch context from Pinecone using embedding
async function fetchContextFromPinecone(query: string): Promise<string> {
  const embedding = await embeddingModel.embedContent(query);
  const response = await namespace.query({
    vector: embedding.embedding.values,
    topK: 30,
    includeMetadata: true,
    includeValues: false,
  });
  return (
    response.matches
      ?.map((match: any) => match.metadata?.chunk_text)
      .join("\n\n") || ""
  );
}

// Helper to build the Gemini prompt string
function buildGeminiPrompt(context: string, query: string): string {
  return `
You are a helpful, factual, and concise sales representative for a fintech company called Aven.

Using the information provided in the following context, answer the user's question.
Context:
${context}

User Question:
${query}
`;
}

// Helper to get non-streaming Gemini completion
async function getGeminiCompletion(
  gemini: OpenAI,
  payload: any,
  logger: Logger,
  logLabel: string = "Completion result"
): Promise<NextResponse> {
  const completion = await gemini.chat.completions.create({
    ...payload,
    stream: false,
  });
  logger.info(logLabel, completion);
  return NextResponse.json(completion);
}

function LogStreamingError(err: unknown) {
  logger.error(
    "Streaming not supported or failed, falling back to non-streaming",
    err
  );
}
