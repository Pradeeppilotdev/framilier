import EventEmitter from "events";
import StrictEventEmitter from "strict-event-emitter-types";
import { ENR, ENRData, SignableENR } from "@chainsafe/enr";
import { IDiscv5DiscoveryInputOptions } from "@chainsafe/discv5";
import { spawn, Thread, Worker } from "@chainsafe/threads";
import { Discv5WorkerApi, Discv5WorkerData } from "./types.js";

export type Discv5Opts = {
  discv5: Omit<
    IDiscv5DiscoveryInputOptions,
    "metrics" | "searchInterval" | "enabled"
  >;
  // logger: Logger;
};

export type Discv5Events = {
  discovered: (enr: ENR) => void;
};

type Discv5WorkerStatus =
  | { status: "stopped" }
  | {
      status: "started";
      workerApi: Discv5WorkerApi;
      subscription: { unsubscribe(): void };
    };

/**
 * Wrapper class abstracting the details of discv5 worker instantiation and message-passing
 */
export class Discv5Worker extends (EventEmitter as {
  new (): StrictEventEmitter<EventEmitter, Discv5Events>;
}) {
  // private logger: Logger;
  private status: Discv5WorkerStatus;

  constructor(private opts: Discv5Opts) {
    super();

    // this.logger = opts.logger;
    this.status = { status: "stopped" };
  }

  async start(): Promise<void> {
    if (this.status.status === "started") return;

    const bootEnrs = (this.opts.discv5.bootEnrs as string[]) || [];

    const workerData = {
      // SignableENRData already carries the raw private key, so the worker
      // thread can fully reconstruct the SignableENR without a separate
      // peerId/keypair handoff (unlike the pre-1.x discv5 API).
      enr: (this.opts.discv5.enr as SignableENR).toObject(),
      bindAddrs: this.opts.discv5.bindAddrs,
      config: this.opts.discv5,
      bootEnrs: JSON.stringify(bootEnrs),
    };

    const worker = new Worker("./worker.js", {
      workerData,
    } as ConstructorParameters<typeof Worker>[1]);

    const workerApi = await spawn<Discv5WorkerApi>(worker, {
      timeout: 5 * 60 * 1000,
    });

    const subscription = workerApi
      .discovered()
      .subscribe((enrObj) => this.onDiscovered(enrObj));

    this.status = { status: "started", workerApi, subscription };
  }

  async stop(): Promise<void> {
    if (this.status.status === "stopped") return;

    this.status.subscription.unsubscribe();
    await this.status.workerApi.close();
    await Thread.terminate(this.status.workerApi as unknown as Thread);

    this.status = { status: "stopped" };
  }

  onDiscovered(obj: ENRData): void {
    const enr = this.decodeEnr(obj);
    if (enr) {
      this.emit("discovered", enr);
    }
  }

  async enr(): Promise<SignableENR> {
    if (this.status.status === "started") {
      const obj = await this.status.workerApi.enr();
      return SignableENR.fromObject(obj);
    } else {
      throw new Error("Cannot get enr before module is started");
    }
  }

  async setEnrValue(key: string, value: Uint8Array): Promise<void> {
    if (this.status.status === "started") {
      await this.status.workerApi.setEnrValue(key, value);
    } else {
      throw new Error("Cannot setEnrValue before module is started");
    }
  }

  async kadValues(): Promise<ENR[]> {
    if (this.status.status === "started") {
      return this.decodeEnrs(await this.status.workerApi.kadValues());
    } else {
      return [];
    }
  }

  async discoverKadValues(): Promise<void> {
    if (this.status.status === "started") {
      await this.status.workerApi.discoverKadValues();
    }
  }

  async findRandomNode(): Promise<ENR[]> {
    if (this.status.status === "started") {
      return this.decodeEnrs(await this.status.workerApi.findRandomNode());
    } else {
      return [];
    }
  }

  private decodeEnrs(objs: ENRData[]): ENR[] {
    const enrs: ENR[] = [];
    for (const obj of objs) {
      const enr = this.decodeEnr(obj);
      if (enr) {
        enrs.push(enr);
      }
    }
    return enrs;
  }

  private decodeEnr(obj: ENRData): ENR | null {
    return new ENR(obj.kvs, obj.seq, obj.signature);
  }
}
