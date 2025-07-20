import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Logger } from "@/utils/logger";
import { env } from "@/config/env";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
//import { GoogleGenAI } from "@google/genai";

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
    const embedding = await embeddingModel.embedContent(query);
    const response = await namespace.query({
      vector: embedding.embedding.values,
      topK: 30,
      includeMetadata: true,
      includeValues: false,
    });

    logger.info("Pinecone response", response);
    const context = response.matches
      ?.map(match => match.metadata?.chunk_text)
      .join("\n\n");
    logger.info("Context:", context);
    const geminiPrompt = `
You are a helpful, factual, and concise sales representative for a fintech company called Aven.

Using the information provided in the following context, answer the user's question.
Context:
${context}

User Question:
${query}
`;
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
    if (
      prompt.choices &&
      prompt.choices[0] &&
      typeof prompt.choices[0] === "object" &&
      "message" in (prompt.choices[0] as any) &&
      (prompt.choices[0] as any).message &&
      typeof (prompt.choices[0] as any).message === "object" &&
      "content" in (prompt.choices[0] as any).message
    ) {
      promptChoice = (prompt.choices[0] as any).message.content;
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

        // Create a ReadableStream for proper SSE streaming
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of completionStream) {
                // Send each chunk as SSE data
                const data = `data: ${JSON.stringify(chunk)}\n\n`;
                controller.enqueue(new TextEncoder().encode(data));
              }
              // Send the [DONE] message to terminate the stream
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            } catch (error) {
              logger.error("Error in streaming:", error);
              controller.error(error);
            }
          },
        });

        // Return streaming response with proper headers
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
      } catch (err) {
        logger.error(
          "Streaming not supported or failed, falling back to non-streaming",
          err
        );
        // Fallback to non-streaming
        const completion = await gemini.chat.completions.create({
          ...completionPayload,
          stream: false,
        });
        logger.info("Completion result (fallback)", completion);
        return NextResponse.json(completion);
      }
    } else {
      const completion = await gemini.chat.completions.create({
        ...completionPayload,
        stream: false,
      });
      logger.info("Completion result", completion);
      return NextResponse.json(completion);
    }
  } catch (e) {
    logger.error("Error in Gemini API call", e);
    return NextResponse.json(
      { error: (e as any)?.message || e },
      { status: 500 }
    );
  }
}
