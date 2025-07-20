import dotenv from "dotenv";
import { Logger } from "@/utils/logger";
import { Pinecone } from "@pinecone-database/pinecone";

dotenv.config();
const logger = new Logger("Get IDs");

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

const namespace = pc
  .index(
    "company-data",
    "https://company-data-r6bdk7j.svc.aped-4627-b74a.pinecone.io"
  )
  .namespace("aven");

async function getIds() {
  try {
    logger.info("=== FETCHING ALL IDs FROM PINECONE ===");

    // Use a dummy query to get all vectors
    const dummyEmbedding = new Array(3072).fill(0);

    const response = await namespace.query({
      vector: dummyEmbedding,
      topK: 100, // Get up to 100 vectors
      includeMetadata: true,
      includeValues: false,
    });

    if (!response.matches || response.matches.length === 0) {
      logger.info("No vectors found in your index.");
      return;
    }

    logger.info(`Found ${response.matches.length} vectors:`);
    logger.info("=".repeat(80));

    // Sort by timestamp (newest first)
    const sortedMatches = response.matches.sort((a, b) => {
      const timeA = parseInt(a.id.split("-").pop() || "0");
      const timeB = parseInt(b.id.split("-").pop() || "0");
      return timeB - timeA; // Newest first
    });

    sortedMatches.forEach((match, index) => {
      const timestamp = match.id.split("-").pop();
      const date = new Date(parseInt(timestamp || "0"));

      logger.info(`\n${index + 1}. ID: ${match.id}`);
      logger.info(`   Timestamp: ${timestamp}`);
      logger.info(`   Date: ${date.toISOString()}`);
      logger.info(`   URL: ${match.metadata?.url}`);
      logger.info(`   Chunk: ${match.metadata?.chunk_index}`);
    });

    logger.info("\n" + "=".repeat(80));
    logger.info("LATEST ID (most recent):");
    logger.info(sortedMatches[0]?.id);
    logger.info("=".repeat(80));
  } catch (error) {
    logger.error("Error fetching IDs:", error);
  }
}

getIds();
