import {build} from "esbuild";
await build({entryPoints:["apps/tally-bridge/src/operator-analysis.ts"],outfile:"apps/tally-bridge/src/operator-analysis.generated.mjs",
 bundle:true,platform:"node",format:"esm",target:"node20",tsconfig:"apps/api/tsconfig.json",legalComments:"none"});
