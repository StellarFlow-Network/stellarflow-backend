import { maskSensitiveData, maskSensitiveObject } from "../src/utils/logMasker";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  // Test 1: Mask Stellar secret key (48-56 characters starting with S, base32)
  const stellarSecret =
    "SBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";
  const maskedSecret = maskSensitiveData(stellarSecret);
  assert(
    maskedSecret.includes("[REDACTED]"),
    "Stellar secret key should be masked",
  );

  // Test 2: Mask values with PASSWORD keyword
  const passwordMsg = "User password is: myverysecurepassword123";
  const maskedPasswordMsg = maskSensitiveData(passwordMsg);
  assert(
    maskedPasswordMsg.includes("[REDACTED]"),
    "PASSWORD keyword should trigger masking",
  );

  // Test 3: Mask database connection string with password
  const dbUrl = "postgresql://username:mypassword@localhost:5432/mydb";
  const maskedDbUrl = maskSensitiveData(dbUrl);
  assert(
    maskedDbUrl.includes("[REDACTED]"),
    "Database password should be masked",
  );
  assert(maskedDbUrl.includes("username"), "Username should not be masked");
  assert(
    !maskedDbUrl.includes("mypassword"),
    "Password should not appear in output",
  );

  // Test 4: Mask Bearer token
  const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const maskedBearer = maskSensitiveData(bearerToken);
  assert(maskedBearer.includes("[REDACTED]"), "Bearer token should be masked");
  assert(
    maskedBearer.startsWith("Bearer"),
    "Bearer prefix should be preserved",
  );

  // Test 5: Mask object with sensitive keys
  const sensitiveObj = {
    username: "john",
    password: "supersecret",
    api_key: "sk_test_12345",
    data: {
      token: "abcdef123456",
      value: 100,
    },
  };
  const maskedObj = maskSensitiveObject(sensitiveObj);
  assert(
    maskedObj.password === "[REDACTED]",
    "password field should be redacted",
  );
  assert(
    maskedObj.api_key === "[REDACTED]",
    "api_key field should be redacted",
  );
  assert(
    maskedObj.data.token === "[REDACTED]",
    "nested token field should be redacted",
  );
  assert(
    maskedObj.username === "john",
    "non-sensitive fields should not be masked",
  );
  assert(maskedObj.data.value === 100, "numeric values should not be affected");

  // Test 6: Mask AWS access key
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const maskedAwsKey = maskSensitiveData(awsKey);
  assert(
    maskedAwsKey.includes("[REDACTED]"),
    "AWS access key should be masked",
  );

  // Test 7: Mask SECRET keyword
  const secretMsg = "Loaded secret key from vault";
  const maskedSecretMsg = maskSensitiveData(secretMsg);
  assert(
    maskedSecretMsg.includes("[REDACTED]"),
    "SECRET keyword should trigger masking",
  );

  // Test 8: Non-sensitive strings should pass through unchanged
  const normalMsg = "Processing request for user john_doe";
  const maskedNormal = maskSensitiveData(normalMsg);
  assert(
    maskedNormal === normalMsg,
    "Non-sensitive strings should not be masked",
  );

  // Test 9: Empty and null inputs
  assert(
    maskSensitiveData("") === "",
    "Empty string should return empty string",
  );
  assert(
    maskSensitiveData(null as any) === null,
    "Null input should return null",
  );

  console.log("✅ All log masking tests passed");
}

run().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
