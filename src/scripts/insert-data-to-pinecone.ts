import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
import { Logger } from "@/utils/logger";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();
const logger = new Logger("Insert Data to Pinecone");
const ai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

// Helper function to chunk text into segments of max 700 characters
function chunkText(text: string, maxChunkSize: number = 700): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  // Split by sentences to maintain context
  const sentences = text
    .split(/[.!?]+/)
    .filter(sentence => sentence.trim().length > 0);

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();

    // If adding this sentence would exceed the limit, save current chunk and start new one
    if (currentChunk.length + trimmedSentence.length + 1 > maxChunkSize) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmedSentence;
      } else {
        // If a single sentence is too long, split it by words
        const words = trimmedSentence.split(" ");
        for (const word of words) {
          if (currentChunk.length + word.length + 1 > maxChunkSize) {
            if (currentChunk.length > 0) {
              chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              chunks.push(word);
            }
          } else {
            currentChunk += (currentChunk.length > 0 ? " " : "") + word;
          }
        }
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? " " : "") + trimmedSentence;
    }
  }

  // Add the last chunk if it has content
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Helper function to remove URLs from text
function removeUrls(text: string): string {
  // Remove markdown-style links but keep the link text
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, "$1");
  // Remove any remaining raw URLs
  text = text.replace(/https?:\/\/[^\s\)\]]+/g, "");
  return text;
}

// Helper function to remove navigation bar items from text
function removeNavBarItems(text: string): string {
  // List of nav items to remove (add more as needed)
  const navItems = [
    "Card",
    "How It Works",
    "Reviews",
    "Support",
    "App",
    "Who We Are",
    "Sign In",
    "About Us",
    "Contact Us",
    "Home",
  ];
  // Remove lines that are just nav items (case-insensitive, with or without dashes or bullets)
  navItems.forEach(item => {
    // Remove lines like: - Card, * Card, Card, etc.
    const regex = new RegExp(`^[-*\s]*${item}[-*\s]*$`, "gmi");
    text = text.replace(regex, "");
    // Remove markdown links like: - [Card](...) or [Card](...)
    const mdRegex = new RegExp(
      `^[-*\s]*\\[${item}\\]\\([^)]*\\)[-*\s]*$`,
      "gmi"
    );
    text = text.replace(mdRegex, "");
  });
  // Remove any extra blank lines left behind
  text = text.replace(/\n{2,}/g, "\n");
  return text;
}

async function main() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const scrapeURLs = [
    "https://www.aven.com",
    "https://www.aven.com/education",
    "https://www.aven.com/support",
    "https://www.aven.com/about",
    "https://www.aven.com/disclosures",
    "https://www.aven.com/education/what-credit-score-is-needed-for-the-aven-card",
    "https://www.aven.com/education/what-is-an-aven-card",
    "https://www.aven.com/education/can-you-get-cash-from-aven-card",
    "https://www.aven.com/education/home-depot-credit-card-vs-aven-home-equity-credit-card",
    "https://www.aven.com/education/mobile-banking-security-tips",
    "https://www.aven.com/education/home-equity-line-of-credit-heloc-card-what-is-it",
    "https://www.aven.com/education/home-equity-line-of-credit-heloc-card-how-it-works",
    "https://www.aven.com/education/home-equity-credit-card-how-to-get-one",
    "https://www.aven.com/education/the-fastest-way-to-get-a-heloc",
    "https://www.aven.com/education/when-are-helocs-home-equity-lines-of-credit-a-good-idea",
    "https://www.aven.com/education/what-is-a-home-equity-line-of-credit-heloc-a-beginners-guide",
    "https://www.aven.com/education/home-equity-lines-credit-helocs-vs-mortgages-similarities-differences",
    "https://www.aven.com/education/how-are-heloc-rates-determined",
    "https://www.aven.com/education/refinancing-a-heloc",
    "https://www.aven.com/education/how-to-get-lowest-rate",
    "https://www.aven.com/education/fixed-or-variable",
    "https://www.aven.com/education/heloc-on-rental-properties",
  ];

  const namespace = pc
    .index(
      "company-data",
      "https://company-data-r6bdk7j.svc.aped-4627-b74a.pinecone.io"
    )
    .namespace("aven");

  const allVectors: any[] = [];

  // Loop through all URLs
  for (const scrapeURL of scrapeURLs) {
    try {
      logger.info(`Scraping URL: ${scrapeURL}`);

      // Scrape the website
      const scrapeResult = await app.scrapeUrl(scrapeURL, {
        formats: ["markdown"],
        onlyMainContent: true,
      });

      if (!scrapeResult.success || !scrapeResult.markdown) {
        logger.error(`Failed to scrape content from ${scrapeURL}`);
        continue;
      }

      // Chunk the text into segments of max 700 characters
      const textChunks = chunkText(scrapeResult.markdown, 700);
      logger.info(`Created ${textChunks.length} chunks for ${scrapeURL}`);

      // Process each chunk
      for (let i = 0; i < textChunks.length; i++) {
        let chunk = textChunks[i];

        // Clean up the chunk by removing URLs and nav bar items
        chunk = removeUrls(chunk);
        chunk = removeNavBarItems(chunk);

        try {
          // Generate embedding for this chunk using the embedding model
          const embeddingModel = ai.getGenerativeModel({
            model: "gemini-embedding-001",
          });
          const result = await embeddingModel.embedContent(chunk);
          const embedding = result.embedding.values;

          if (!embedding || embedding.length === 0) {
            logger.error(
              `No embeddings generated for chunk ${i} of ${scrapeURL}`
            );
            continue;
          }

          // Add to vectors array
          allVectors.push({
            id: `${scrapeURL}-chunk-${i}-${Date.now()}`,
            values: embedding,
            metadata: {
              chunk_text: chunk,
              category: "aven",
              url: scrapeURL,
              chunk_index: i,
              total_chunks: textChunks.length,
              scraped_at: new Date().toISOString(),
            },
          });

          logger.info(
            `Processed chunk ${i + 1}/${textChunks.length} for ${scrapeURL}`
          );

          // Add a small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          logger.error(`Error processing chunk ${i} of ${scrapeURL}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error scraping ${scrapeURL}:`, error);
    }
  }

  // Upload all vectors to Pinecone in batches
  if (allVectors.length > 0) {
    logger.info(`Uploading ${allVectors.length} vectors to Pinecone...`);

    // Pinecone has a limit of 100 vectors per request, so we need to batch
    const batchSize = 100;
    for (let i = 0; i < allVectors.length; i += batchSize) {
      const batch = allVectors.slice(i, i + batchSize);

      try {
        const pineconeResponse = await namespace.upsert(batch);
        logger.info(
          `Successfully uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allVectors.length / batchSize)}`
        );
      } catch (error) {
        logger.error(
          `Error uploading batch ${Math.floor(i / batchSize) + 1}:`,
          error
        );
      }

      // Add delay between batches
      if (i + batchSize < allVectors.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info(
      `Successfully processed and uploaded ${allVectors.length} vectors to Pinecone`
    );
  } else {
    logger.error("No vectors were created successfully");
  }
}

main();
