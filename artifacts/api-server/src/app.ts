import express, { type Express } from "express";
import path from "node:path";
import { existsSync as fsExists } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

// When bundled (dist/index.mjs), the public assets live in dist/public;
// when run from source, they're in ../public. Prefer the dist-local copy.
const _here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = fsExists(path.resolve(_here, "public"))
  ? path.resolve(_here, "public")
  : path.resolve(_here, "../public");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Wallet-connect signing webapp (public/signing.html + bundled signing.js).
app.use(express.static(PUBLIC_DIR));
app.get("/signing", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "signing.html"));
});

// Root route: the platform's "primary URL" check hits this — return a
// friendly JSON payload instead of a 404.
app.get("/", (_req, res) => {
  res.json({
    service: "DexBoost",
    status: "ok",
    endpoints: {
      health: "/api/healthz",
      botStatus: "/api/health/bot",
      signing: "/signing",
    },
  });
});

app.use("/api", router);

export default app;
