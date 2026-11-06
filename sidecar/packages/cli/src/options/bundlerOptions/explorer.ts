import { ICliCommandOptions } from "../../util/index.js";

export interface IExplorerArgs {
  "explorer.enable": boolean;
}

export const options: ICliCommandOptions<IExplorerArgs> = {
  "explorer.enable": {
    type: "boolean",
    description:
      "Record admission/lifecycle history and serve the read-only skandha_explorer_* RPC methods",
    default: false,
    group: "explorer",
    demandOption: false,
  },
};
