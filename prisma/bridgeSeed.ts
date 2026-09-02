import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding bridge chains and validators...");

  // Clear existing data
  await prisma.bridgeValidatorSignature.deleteMany();
  await prisma.bridgeOperation.deleteMany();
  await prisma.bridgeEvent.deleteMany();
  await prisma.bridgeValidator.deleteMany();
  await prisma.bridgeChain.deleteMany();

  // Create bridge chains
  const ethereum = await prisma.bridgeChain.create({
    data: {
      chainId: "1",
      chainName: "Ethereum",
      chainType: "EVM",
      rpcUrl: "https://eth.llamarpc.com",
      explorerUrl: "https://etherscan.io",
      bridgeContract: "0x0000000000000000000000000000000000000000", // Replace with actual contract
      isActive: true,
    },
  });

  const polygon = await prisma.bridgeChain.create({
    data: {
      chainId: "137",
      chainName: "Polygon",
      chainType: "EVM",
      rpcUrl: "https://polygon.llamarpc.com",
      explorerUrl: "https://polygonscan.com",
      bridgeContract: "0x0000000000000000000000000000000000000000", // Replace with actual contract
      isActive: true,
    },
  });

  const stellar = await prisma.bridgeChain.create({
    data: {
      chainId: "stellar",
      chainName: "Stellar",
      chainType: "Stellar",
      rpcUrl: null,
      explorerUrl: "https://stellar.expert",
      bridgeContract: null,
      isActive: true,
    },
  });

  console.log("Created bridge chains:", { ethereum, polygon, stellar });

  // Create validators for each chain (example addresses - replace with real validators)
  const ethValidators = [
    {
      chainId: ethereum.id,
      validatorAddress: "0x1234567890123456789012345678901234567890",
      validatorName: "Ethereum Validator 1",
      weight: 1,
    },
    {
      chainId: ethereum.id,
      validatorAddress: "0x0987654321098765432109876543210987654321",
      validatorName: "Ethereum Validator 2",
      weight: 1,
    },
    {
      chainId: ethereum.id,
      validatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      validatorName: "Ethereum Validator 3",
      weight: 1,
    },
  ];

  const polygonValidators = [
    {
      chainId: polygon.id,
      validatorAddress: "0x1234567890123456789012345678901234567890",
      validatorName: "Polygon Validator 1",
      weight: 1,
    },
    {
      chainId: polygon.id,
      validatorAddress: "0x0987654321098765432109876543210987654321",
      validatorName: "Polygon Validator 2",
      weight: 1,
    },
  ];

  const stellarValidators = [
    {
      chainId: stellar.id,
      validatorAddress: "GABCD1234567890ABCDEFGH1234567890AB",
      validatorName: "Stellar Validator 1",
      weight: 1,
    },
    {
      chainId: stellar.id,
      validatorAddress: "GDCBA0987654321FEDCBA0987654321FE",
      validatorName: "Stellar Validator 2",
      weight: 1,
    },
  ];

  // Create validators
  for (const validator of [...ethValidators, ...polygonValidators, ...stellarValidators]) {
    await prisma.bridgeValidator.create({
      data: validator,
    });
  }

  console.log("Created validators for all chains");

  console.log("Bridge seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("Error seeding bridge data:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
