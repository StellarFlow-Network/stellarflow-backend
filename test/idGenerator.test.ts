import { generateSortableLogId } from "../src/utils/idGenerator";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const ids = Array.from({ length: 20 }, () => generateSortableLogId());

  assert(ids.length === 20, "Should generate 20 IDs");
  assert(
    ids.every((id) => id.length === 26),
    "Log IDs must be 26 characters long",
  );
  assert(
    ids.every((id) => /^[0-9A-Z]{26}$/.test(id)),
    "Log IDs must only contain valid Crockford base32 characters",
  );
  assert(
    ids.every((id) => !/[ILOU]/.test(id)),
    "Log IDs must not contain ambiguous Crockford base32 characters",
  );
  assert(
    ids.every((id, index) => (index === 0 ? true : ids[index - 1] < id)),
    "Log IDs should be monotonic in sequential generation order",
  );

  const uniqueCount = new Set(ids).size;
  assert(uniqueCount === ids.length, "All generated log IDs must be unique");

  console.log("✅ K-sortable log ID generator tests passed");
}

run().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
