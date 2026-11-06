import fastify, {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ServerConfig } from "@skandha/types/lib/api/interfaces";
import logger from "./logger.js";
import { toErrorResponse } from "./utils/errorResponse.js";

export class Server {
  constructor(
    public http: FastifyInstanceAny,
    public ws: FastifyInstanceAny | null,
    private config: ServerConfig
  ) {}

  static async init(config: ServerConfig): Promise<Server> {
    let ws: FastifyInstanceAny | null = null;
    const app = fastify({
      logger,
      disableRequestLogging: !config.enableRequestLogging,
      ignoreTrailingSlash: true,
    });

    await app.register(cors, {
      origin: config.cors,
    });

    if (config.ws) {
      if (config.wsPort == config.port) {
        await app.register(websocket);
        ws = app;
      } else {
        ws = fastify({
          logger,
          disableRequestLogging: !config.enableRequestLogging,
          ignoreTrailingSlash: true,
        });
      }
    }

    app.addHook("preHandler", (req, reply, done) => {
      
      if (req.url === "/version" || req.url === "/healthcheck") {
        // do nothing
      } else if (req.method === "POST") {
        req.log.info(
          {
            method: req.method,
            url: req.url,
            body: req.body,
          },
          "REQUEST ::"
        );
      } else {
        req.log.info(
          {
            method: req.method,
            url: req.url,
          },
          "REQUEST ::"
        );
      }
      done();
    });
    // RESPONSE LOG
    app.addHook("preSerialization", (request, reply, payload, done) => {
      if (payload) {
        request.log.info({ body: payload }, "RESPONSE ::");
      }
      done();
    });

    return new Server(app, ws, config);
  }

  async listen(): Promise<void> {
    const errorHandler = (
      err: FastifyError,
      req: FastifyRequest,
      res: FastifyReply
    ): FastifyReply => {
      // eslint-disable-next-line no-console
      logger.error(err);

      const { status, payload } = toErrorResponse(err, req.body);
      return res.status(status).send(payload);
    };

    this.http.setErrorHandler(errorHandler);
    this.http.listen(
      {
        port: this.config.port,
        host: this.config.host,
        listenTextResolver: (address) =>
          `HTTP server listening at ${address}/rpc`,
      },
      (err) => {
        if (err) throw err;
        if (this.http.websocketServer != null) {
          this.http.log.info(
            `Websocket server listening at ws://${this.config.host}:${this.config.port}/rpc`
          );
        }
      }
    );

    if (this.config.ws && this.config.wsPort != this.config.port) {
      this.ws?.setErrorHandler(errorHandler);
      this.ws?.listen(
        {
          port: this.config.wsPort,
          host: this.config.host,
          listenTextResolver: () =>
            `Websocket server listening at ws://${this.config.host}:${this.config.wsPort}/rpc`,
        },
        (err) => {
          if (err) throw err;
        }
      );
    }
  }
}

/// @note to address the bug in fastify types, will be removed in future
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyInstanceAny = FastifyInstance<any, any, any, any, any>;
