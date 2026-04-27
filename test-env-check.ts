import { validateEnv } from "./src/utils/envValidator";

console.log("Testing validateEnv...");
try {
  validateEnv();
  console.log("Check passed (unexpected if env vars are missing)");
} catch (e) {
  console.log("Caught error:", e);
}
