/**
 * Test the ollama-client abstraction layer.
 * Run with different env vars to test routing:
 *   npx tsx scripts/test-ollama-client.ts                    # native Ollama
 *   DEFENSECLAW_OLLAMA_URL=http://localhost:9001 ... test    # through DefenseClaw
 */
import { ollamaChat, ollamaEmbed } from './lib/ollama-client.js';

async function main() {
  console.log("=== ollama-client test ===");
  console.log(`OLLAMA_URL: ${process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "default"}`);
  console.log(`DEFENSECLAW_OLLAMA_URL: ${process.env.DEFENSECLAW_OLLAMA_URL || "not set"}`);
  console.log(`DEFENSECLAW_KEY: ${process.env.DEFENSECLAW_KEY ? "set" : "not set"}`);

  // Test 1: Chat
  console.log("\n--- Test 1: Chat ---");
  const chat = await ollamaChat({
    model: "gemma3:27b",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say OK and nothing else." },
    ],
    options: { num_ctx: 4096, temperature: 0.1 },
  });
  console.log(`Content: "${chat.content}"`);
  console.log(`Tokens: ${chat.promptTokens} in, ${chat.completionTokens} out`);
  console.log(`Latency: ${chat.latencyMs}ms`);
  console.log(`PASS: ${chat.content.length > 0}`);

  // Test 2: Embed
  console.log("\n--- Test 2: Embed ---");
  const embeddings = await ollamaEmbed({ input: "test embedding" });
  console.log(`Dimensions: ${embeddings[0]?.length || 0}`);
  console.log(`PASS: ${embeddings[0]?.length === 768}`);

  console.log("\n=== All tests passed ===");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
