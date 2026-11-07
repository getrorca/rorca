#!/usr/bin/env node
/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {certifyStrictMemoryLinuxSandbox} from '../src/lib/strict-memory-sandbox';

async function main():Promise<void>{
  const output=process.argv[2];
  if(!output||!path.isAbsolute(output)||!output.endsWith('.json'))throw new Error('usage: npm run certify:strict-memory-linux -- /absolute/invocation-owned-receipt.json');
  if(fs.existsSync(output))throw new Error('certification receipt path must not already exist');
  const receipt=await certifyStrictMemoryLinuxSandbox();
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,`${JSON.stringify(receipt,null,2)}\n`,{flag:'wx',mode:0o600});
  process.stdout.write(`${output}\n`);
}

main().catch((error:unknown)=>{
  const reason=error&&typeof error==='object'&&'reasonCode' in error?String((error as {reasonCode:unknown}).reasonCode):'certification_failed';
  process.stderr.write(`strict-memory Linux certification failed closed: ${reason}\n`);
  process.exitCode=1;
});
