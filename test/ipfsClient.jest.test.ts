import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const { IpfsHttpClient, IpfsApiError } =
  await import("../src/services/ipfsClient.js");

function createFetchMock() {
  return jest.fn<typeof fetch>();
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

const originalApiUrl = process.env.IPFS_API_URL;
const originalGatewayUrl = process.env.IPFS_GATEWAY_URL;

let fetchFn: ReturnType<typeof createFetchMock>;

beforeEach(() => {
  delete process.env.IPFS_API_URL;
  delete process.env.IPFS_GATEWAY_URL;
  fetchFn = createFetchMock();
});

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env.IPFS_API_URL;
  else process.env.IPFS_API_URL = originalApiUrl;
  if (originalGatewayUrl === undefined) delete process.env.IPFS_GATEWAY_URL;
  else process.env.IPFS_GATEWAY_URL = originalGatewayUrl;
});

describe("IpfsHttpClient", () => {
  it("reports unconfigured until IPFS_API_URL is set", () => {
    expect(new IpfsHttpClient().isConfigured()).toBe(false);

    process.env.IPFS_API_URL = "http://127.0.0.1:5001/";
    expect(new IpfsHttpClient().isConfigured()).toBe(true);
  });

  it("builds verification links from the configured gateway", () => {
    const client = new IpfsHttpClient({ gatewayUrl: "https://ipfs.io/ipfs/" });

    expect(client.gatewayUrl("bafycid")).toBe("https://ipfs.io/ipfs/bafycid");
    expect(
      new IpfsHttpClient({ gatewayUrl: "https://gw.example/ipfs" }).gatewayUrl(
        "bafycid",
      ),
    ).toBe("https://gw.example/ipfs/bafycid");
  });

  it("uploads the snapshot as a pinned CIDv1 and returns the hash", async () => {
    fetchFn.mockResolvedValue(
      okResponse('{"Name":"snapshot","Hash":"bafyresult","Size":"42"}\n'),
    );
    const client = new IpfsHttpClient({
      apiUrl: "http://ipfs-node:5001",
      fetchFn,
    });

    const content = Buffer.from('{"schema":"snapshot"}', "utf8");
    const result = await client.add(content, "42-governance-result.json");

    expect(result).toEqual({ cid: "bafyresult" });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(
      "http://ipfs-node:5001/api/v0/add" +
        "?cid-version=1&pin=true&raw-leaves=true&wrap-with-directory=false",
    );
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    const contentType = headers["content-type"] ?? "";
    expect(contentType).toContain("multipart/form-data; boundary=");
    const boundary = contentType.split("boundary=")[1] ?? "";
    const body = Buffer.from(init?.body as Uint8Array).toString("utf8");
    expect(body).toContain('filename="42-governance-result.json"');
    expect(body).toContain('{"schema":"snapshot"}');
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it("rejects non-success responses with the HTTP status", async () => {
    fetchFn.mockResolvedValue(new Response("boom", { status: 500 }));
    const client = new IpfsHttpClient({
      apiUrl: "http://ipfs-node:5001",
      fetchFn,
    });

    await expect(client.add(Buffer.from("{}"), "s.json")).rejects.toMatchObject(
      {
        name: "IpfsApiError",
        status: 500,
      },
    );
    await expect(
      client.add(Buffer.from("{}"), "s.json"),
    ).rejects.toBeInstanceOf(IpfsApiError);
  });

  it("rejects responses that carry no CID", async () => {
    fetchFn.mockResolvedValue(okResponse('{"Name":"snapshot"}'));
    const client = new IpfsHttpClient({
      apiUrl: "http://ipfs-node:5001",
      fetchFn,
    });

    await expect(client.add(Buffer.from("{}"), "s.json")).rejects.toThrow(
      "did not contain a CID",
    );
  });

  it("refuses to publish when no API endpoint is configured", async () => {
    const client = new IpfsHttpClient({ fetchFn });

    await expect(client.add(Buffer.from("{}"), "s.json")).rejects.toThrow(
      "not configured",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
