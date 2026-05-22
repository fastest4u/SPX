import assert from "node:assert/strict";

process.env.DB_MODE = "memory";

async function main(): Promise<void> {
  const { resetMemoryStore } = await import("../src/db/client-memory.js");
  const { closePool } = await import("../src/db/client.js");
  const { insertLineImageExtraction } = await import("../src/repositories/line-image-extraction-repository.js");
  const { lineImageExtractionController } = await import("../src/controllers/line-image-extraction-controller.js");
  const Fastify = (await import("fastify")).default;

  resetMemoryStore();
  const app = Fastify({ logger: false });

  try {
    await insertLineImageExtraction({
      chatId: "c1",
      senderId: "u1",
      imagePath: "data/line-images/2026-05/a.jpg",
      dateText: "16 May 2026",
      tripNumber: "LT0Q5L2657AJ2",
      driverName: "LH-PWL driver",
      agencyName: "LH-PWL",
      vehicleType: "6WH",
      route: "NERC-C > SOCE",
      rawText: "raw one",
    });
    await insertLineImageExtraction({
      chatId: "c1",
      senderId: "u2",
      imagePath: "data/line-images/2026-05/b.jpg",
      dateText: "17 May 2026",
      tripNumber: "LT0Q5L9999999",
      driverName: "Other driver",
      agencyName: "LH-IFN",
      vehicleType: "4WH",
      route: "BKK > CNX",
      rawText: "raw two",
    });

    await app.register(lineImageExtractionController, { prefix: "/line-image-extractions" });

    const response = await app.inject({
      method: "GET",
      url: "/line-image-extractions?agency=LH-PWL&tripNumber=LT0Q5L2657AJ2&route=SOCE&page=1&pageSize=10",
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, "success");
    assert.equal(body.meta.total_items, 1);
    assert.equal(body.data[0].agencyName, "LH-PWL");
    assert.equal(body.data[0].tripNumber, "LT0Q5L2657AJ2");
    assert.equal(body.data[0].route, "NERC-C > SOCE");
    assert.equal(body.data[0].imageUrl, "/line-images/2026-05/a.jpg");
  } finally {
    await app.close();
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
