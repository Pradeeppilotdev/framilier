import { WebSocket } from "ws";
import { Executor } from "@skandha/executor/lib/executor";
import { Config } from "@skandha/executor/lib/config";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { deepHexlify } from "@skandha/utils/lib/hexlify.js";
import {
  BundlerRPCMethods,
  CustomRPCMethods,
  HttpStatus,
  RedirectedRPCMethods,
} from "./constants.js";
import {
  EthAPI,
  ExplorerAPI,
  DebugAPI,
  Web3API,
  RedirectAPI,
  SubscriptionApi,
} from "./modules/index.js";
import { SkandhaAPI } from "./modules/skandha.js";
import { JsonRpcRequest, JsonRpcResponse } from "./interface.js";
import { Server } from "./server.js";
import { toErrorResponse } from "./utils/errorResponse.js";

const INVALID_PARAMS = -32602;

function wsErrorResponse(error: unknown, request?: JsonRpcRequest): JsonRpcResponse {
  return toErrorResponse(error instanceof Error ? error : new Error("Unexpected RPC failure"), request).payload as JsonRpcResponse;
}

export interface RpcHandlerOptions {
  config: Config;
}

export interface EtherspotBundlerOptions {
  server: Server;
  config: Config;
  executor: Executor;
  testingMode: boolean;
  redirectRpc: boolean;
}

export interface RelayerAPI {
  relayer: Executor;
  ethApi: EthAPI;
  debugApi: DebugAPI;
  web3Api: Web3API;
  skandhaApi: SkandhaAPI;
}

export class ApiApp {
  private server: Server;
  private config: Config;
  private executor: Executor;

  private testingMode = false;
  private redirectRpc = false;

  private ethApi: EthAPI;
  private debugApi: DebugAPI;
  private web3Api: Web3API;
  private redirectApi: RedirectAPI;
  private skandhaApi: SkandhaAPI;
  private explorerApi: ExplorerAPI;
  private subscriptionApi: SubscriptionApi;

  constructor(options: EtherspotBundlerOptions) {
    this.server = options.server;
    this.config = options.config;
    this.testingMode = options.testingMode;
    this.redirectRpc = options.redirectRpc;
    this.executor = options.executor;

    this.subscriptionApi = new SubscriptionApi(
      this.executor.subscriptionService
    );
    this.ethApi = new EthAPI(this.executor.eth);
    this.debugApi = new DebugAPI(this.executor.debug);
    this.web3Api = new Web3API(this.executor.web3);
    this.redirectApi = new RedirectAPI(this.config);
    this.skandhaApi = new SkandhaAPI(this.executor.skandha);
    this.explorerApi = new ExplorerAPI(
      this.executor.explorer,
      this.executor.faucet
    );

    // HTTP interface
    this.server.http.post("/rpc/", async (req, res): Promise<void> => {
      let response = null;
      let { body } = req;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (err) {
          throw new RpcError(
            "Cannot parse request",
            RpcErrorCodes.INVALID_REQUEST
          );
        }
      }
      if (Array.isArray(body)) {
        response = [];
        for (const request of body) {
          response.push(
            await this.handleRpcRequest(
              request,
              req.ip,
              req.headers.authorization
            )
          );
        }
      } else {
        response = await this.handleRpcRequest(
          body as JsonRpcRequest,
          req.ip,
          req.headers.authorization
        );
      }
      return res.status(HttpStatus.OK).send(response);
    });
    this.server.http.get("*", async (req, res) => {
      void res
        .status(200)
        .send("GET requests are not supported. Visit https://skandha.fyi");
    });

    if (this.server.ws != null) {
      this.server.ws.get("/rpc/", { websocket: true }, async (socket, req) => {
        socket.on("message", async (message) => {
          let request: JsonRpcRequest | undefined;
          let response: JsonRpcResponse;
          try {
            let parsed: unknown;
            try { parsed = JSON.parse(message.toString()); }
            catch { throw new RpcError("Parse error", RpcErrorCodes.PARSE_ERROR); }
            const candidate = parsed as JsonRpcRequest;
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
                candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string" ||
                (Object.hasOwn(candidate, "id") && candidate.id !== null &&
                 typeof candidate.id !== "string" &&
                 (typeof candidate.id !== "number" || !Number.isFinite(candidate.id)))) {
              throw new RpcError("Invalid Request", RpcErrorCodes.INVALID_REQUEST);
            }
            request = candidate;
            if (await this.handleWsRequest(socket, request)) return;
            response = await this.handleRpcRequest(request, req.ip, req.headers.authorization);
          } catch (err) {
            response = wsErrorResponse(err, request);
          }
          socket.send(JSON.stringify(response));
        });
      });
    }
  }

  private async handleWsRequest(
    socket: WebSocket,
    request: JsonRpcRequest
  ): Promise<boolean> {
    let response: JsonRpcResponse | undefined;
    const { method, params, jsonrpc, id } = request;
    try {
      switch (method) {
        case CustomRPCMethods.skandha_subscribe: {
          if (!Array.isArray(params) || params.length < 1 || params.length > 2 || typeof params[0] !== "string") {
            throw new RpcError("Expected subscription event parameters", INVALID_PARAMS);
          }
          const eventId = this.subscriptionApi.subscribe(
            socket,
            params[0],
            params[1]
          );
          response = { jsonrpc, id, result: eventId };
          break;
        }
        case CustomRPCMethods.skandha_unsubscribe: {
          if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "string") {
            throw new RpcError("Expected a subscription id", INVALID_PARAMS);
          }
          this.subscriptionApi.unsubscribe(socket, params[0]);
          response = { jsonrpc, id, result: "ok" };
          break;
        }
        default: {
          return false; // the request can not be handled by this function
        }
      }
    } catch (err) {
      response = wsErrorResponse(err, request);
    }
    if (response != undefined) {
      socket.send(JSON.stringify(response));
    }
    return true; // The subscription request was handled and answered.
  }

  private async handleRpcRequest(
    request: JsonRpcRequest,
    ip: string,
    authKey?: string
  ): Promise<JsonRpcResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    const { method, params, jsonrpc, id } = request;
    // A configured key always takes precedence, including on loopback.
    // Unauthenticated test access is explicit and confined to local fixtures.
    const adminKey = process.env.SKANDHA_ADMIN_KEY;
    const loopback = ip === "localhost" || ip === "127.0.0.1" ||
      ip === "::1" || ip === "::ffff:127.0.0.1";
    const authorized = adminKey ? authKey === adminKey : this.testingMode && loopback;
    if (authorized) {
      switch (method) {
        case BundlerRPCMethods.debug_bundler_setBundlingMode:
          result = await this.debugApi.setBundlingMode(params[0]);
          break;
        case BundlerRPCMethods.debug_bundler_setBundleInterval:
          result = await this.debugApi.setBundlingInterval({
            interval: params[0],
          });
          break;
        case BundlerRPCMethods.debug_bundler_clearState:
          result = await this.debugApi.clearState();
          break;
        case BundlerRPCMethods.debug_bundler_clearMempool:
          result = await this.debugApi.clearMempool();
          break;
        case BundlerRPCMethods.debug_bundler_dumpMempool:
          result = await this.debugApi.dumpMempool(/* params[0] */);
          break;
        case BundlerRPCMethods.debug_bundler_dumpMempoolRaw:
          result = await this.debugApi.dumpMempoolRaw(/* params[0] */);
          break;
        case BundlerRPCMethods.debug_bundler_setReputation:
          result = await this.debugApi.setReputation({
            reputations: params[0],
            entryPoint: params[1],
          });
          break;
        case BundlerRPCMethods.debug_bundler_dumpReputation:
          result = await this.debugApi.dumpReputation({
            entryPoint: params[0],
          });
          break;
        case BundlerRPCMethods.debug_bundler_sendBundleNow:
          result = await this.debugApi.sendBundleNow();
          break;

        case BundlerRPCMethods.debug_bundler_setMempool:
          result = await this.debugApi.setMempool({
            txs: params[0],
          });
          break;
        case BundlerRPCMethods.debug_bundler_getStakeStatus:
          result = await this.debugApi.getStakeStatus({
            address: params[0],
            entryPoint: params[1],
          });
          break;
        case BundlerRPCMethods.debug_bundler_clearReputation:
          result = await this.debugApi.clearReputation();
          break;
        case BundlerRPCMethods.debug_bundler_setPrivilegedRelayTargetBlock:
          result = await this.debugApi.setPrivilegedRelayTargetBlock({
            txHash: params[0],
            targetBlock: params[1],
          });
          break;
      }
    }

    if (this.redirectRpc && method in RedirectedRPCMethods) {
      const body = await this.redirectApi.redirect(method, params);
      return { jsonrpc, id, ...body };
    }

    if (!result) {
      switch (method) {
        case BundlerRPCMethods.eth_chainId:
          result = await this.ethApi.getChainId();
          break;
        case BundlerRPCMethods.eth_sendFrameTransaction:
          result = await this.ethApi.sendFrameTransaction(params[0]);
          break;
        case BundlerRPCMethods.eth_estimateFrameTransactionGas:
          result = await this.ethApi.estimateFrameTransactionGas(params[0]);
          break;
        case BundlerRPCMethods.eth_getFrameTransactionReceipt:
          result = await this.ethApi.getFrameTransactionReceipt(params[0]);
          break;
        case BundlerRPCMethods.eth_getFrameTransactionByHash:
          result = await this.ethApi.getFrameTransactionByHash(params[0]);
          break;
        case BundlerRPCMethods.web3_clientVersion:
          result = this.web3Api.clientVersion();
          break;
        case CustomRPCMethods.skandha_getGasPrice:
          result = await this.skandhaApi.getGasPrice();
          break;
        case CustomRPCMethods.skandha_config:
          result = await this.skandhaApi.getConfig();
          // skip hexlify for this particular rpc
          return { jsonrpc, id, result };
        // Explorer results are plain JSON; deepHexlify would turn every number into a hex string.
        case CustomRPCMethods.skandha_explorer_info:
          return { jsonrpc, id, result: this.explorerApi.info() };
        case CustomRPCMethods.skandha_explorer_listTransactions:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.listTransactions(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_listAdmissions:
          return {
            jsonrpc,
            id,
            result: this.explorerApi.listAdmissions(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_getTransaction:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.getTransaction(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_peers:
          return { jsonrpc, id, result: this.explorerApi.peers() };
        case CustomRPCMethods.skandha_explorer_listReputation:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.listReputation(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_faucet:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.faucetDrip(params?.[0]),
          };
        case CustomRPCMethods.skandha_frameTransactionStatus:
          result = await this.skandhaApi.getFrameTransactionStatus(params[0]);
          break;
        case CustomRPCMethods.skandha_connectedPeers:
          result = this.skandhaApi.connectedPeers();
          break;
        default:
          throw new RpcError(
            `Method ${method} is not supported`,
            RpcErrorCodes.METHOD_NOT_FOUND
          );
      }
    }

    result = deepHexlify(result);
    return { jsonrpc, id, result };
  }
}
