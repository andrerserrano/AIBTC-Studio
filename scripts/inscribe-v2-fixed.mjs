import * as btc from '@scure/btc-signer';
import { p2tr_ord_reveal, OutOrdinalReveal } from 'micro-ordinals';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, writeFileSync } from 'fs';

const MNEMONIC = process.env.MNEMONIC;
const network = btc.NETWORK;
const FEE_RATE = 1;
const NUMS_KEY = new Uint8Array(32).fill(0x50);

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);

const bip84 = root.derive("m/84'/0'/0'/0/0");
const fundingPrivKey = new Uint8Array(bip84.privateKey);
const fundingPayment = btc.p2wpkh(new Uint8Array(bip84.publicKey), network);

const bip86 = root.derive("m/86'/0'/0'/0/0");
const taprootPrivKey = new Uint8Array(bip86.privateKey);
const taprootPubKey = new Uint8Array(bip86.publicKey).slice(1);
const taprootPayment = btc.p2tr(taprootPubKey, undefined, network);

console.log('Funding:', fundingPayment.address);
console.log('Taproot:', taprootPayment.address);

const images = [
  { id: 'seed-2', title: 'Governance Proposal #47', file: '.data/inscription-webp-v2/seed-2-composed.webp' },
  { id: 'seed-1', title: 'The sBTC Bridge Opens', file: '.data/inscription-webp-v2/seed-1-composed.webp' },
  { id: 'seed-3', title: 'Clarity Smart Contract Audit', file: '.data/inscription-webp-v2/seed-3-composed.webp' },
  { id: 'cartoon-btc-agents', title: 'AI Agents Prefer Bitcoin', file: '.data/inscription-webp-v2/cartoon-btc-agents-composed.webp' },
  { id: 'cartoon-cafeteria', title: 'Block Layoffs', file: '.data/inscription-webp-v2/cartoon-cafeteria-composed.webp' },
];

async function broadcast(txHex) {
  const res = await fetch('https://mempool.space/api/tx', { method: 'POST', body: txHex });
  if (!res.ok) throw new Error(`Broadcast failed: ${await res.text()}`);
  return await res.text();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// First: complete the pending reveal for seed-2 (commit already broadcast)
async function completeReveal() {
  const image = images[0]; // seed-2
  const imageData = readFileSync(image.file);
  console.log(`\n--- Completing reveal for ${image.id} ---`);

  const inscription = {
    tags: { contentType: 'image/webp' },
    body: new Uint8Array(imageData),
  };

  const reveal = p2tr_ord_reveal(taprootPubKey, [inscription]);
  const inscriptionPayment = btc.p2tr(NUMS_KEY, { script: reveal.script }, network, true, [OutOrdinalReveal]);
  
  const revealVSize = Math.ceil(100 + imageData.length / 4);
  const revealFee = revealVSize * FEE_RATE;
  const inscriptionAmount = BigInt(546 + revealFee);

  const revealTx = new btc.Transaction({
    allowUnknownOutputs: true,
    customScripts: [OutOrdinalReveal],
  });

  revealTx.addInput({
    txid: '2d3892ecdcceec467a47186f8abf081e58ce1080c36825d7f5fad3e731f4d791',
    index: 0,
    witnessUtxo: {
      script: inscriptionPayment.script,
      amount: inscriptionAmount,
    },
    tapLeafScript: inscriptionPayment.tapLeafScript,
  });

  // Fixed: use addOutputAddress instead of manual script
  revealTx.addOutputAddress(taprootPayment.address, 546n, network);

  revealTx.sign(taprootPrivKey);
  revealTx.finalize();
  const revealHex = hex.encode(revealTx.extract());
  const revealTxid = await broadcast(revealHex);
  console.log(`Reveal txid: ${revealTxid}`);
  console.log(`Inscription ID: ${revealTxid}i0`);
  return { id: image.id, title: image.title, inscriptionId: `${revealTxid}i0`,
    commitTxid: '2d3892ecdcceec467a47186f8abf081e58ce1080c36825d7f5fad3e731f4d791',
    revealTxid, costSats: Number(inscriptionAmount) + 150 };
}

async function inscribeOne(image, utxo) {
  console.log(`\n--- Inscribing ${image.id} ---`);
  const imageData = readFileSync(image.file);
  console.log(`Image size: ${imageData.length} bytes`);

  const inscription = {
    tags: { contentType: 'image/webp' },
    body: new Uint8Array(imageData),
  };

  const reveal = p2tr_ord_reveal(taprootPubKey, [inscription]);
  const inscriptionPayment = btc.p2tr(NUMS_KEY, { script: reveal.script }, network, true, [OutOrdinalReveal]);

  const revealVSize = Math.ceil(100 + imageData.length / 4);
  const revealFee = revealVSize * FEE_RATE;
  const inscriptionAmount = BigInt(546 + revealFee);

  // Commit tx
  const commitTx = new btc.Transaction({ allowUnknownOutputs: true });
  commitTx.addInput({
    txid: utxo.txid, index: utxo.vout,
    witnessUtxo: { script: fundingPayment.script, amount: BigInt(utxo.value) },
  });
  commitTx.addOutputAddress(inscriptionPayment.address, inscriptionAmount, network);

  const commitFee = 150n;
  const change = BigInt(utxo.value) - inscriptionAmount - commitFee;
  if (change > 546n) {
    commitTx.addOutputAddress(fundingPayment.address, change, network);
  }

  commitTx.sign(fundingPrivKey);
  commitTx.finalize();
  const commitTxid = await broadcast(hex.encode(commitTx.extract()));
  console.log(`Commit: ${commitTxid}`);

  await sleep(3000);

  // Reveal tx - FIXED: use addOutputAddress
  const revealTx = new btc.Transaction({
    allowUnknownOutputs: true,
    customScripts: [OutOrdinalReveal],
  });
  revealTx.addInput({
    txid: commitTxid, index: 0,
    witnessUtxo: { script: inscriptionPayment.script, amount: inscriptionAmount },
    tapLeafScript: inscriptionPayment.tapLeafScript,
  });
  revealTx.addOutputAddress(taprootPayment.address, 546n, network);

  revealTx.sign(taprootPrivKey);
  revealTx.finalize();
  const revealTxid = await broadcast(hex.encode(revealTx.extract()));
  console.log(`Reveal: ${revealTxid}`);
  console.log(`Inscription: ${revealTxid}i0`);

  const costSats = Number(inscriptionAmount) + Number(commitFee);
  return {
    id: image.id, title: image.title,
    inscriptionId: `${revealTxid}i0`, commitTxid, revealTxid, costSats,
    changeUtxo: change > 546n ? { txid: commitTxid, vout: 1, value: Number(change) } : null,
  };
}

async function main() {
  const results = [];

  // Step 1: Complete pending seed-2 reveal
  const seed2Result = await completeReveal();
  results.push(seed2Result);
  console.log('Waiting 15s...');
  await sleep(15000);

  // Step 2: Inscribe remaining 4 using change UTXO
  let currentUtxo = {
    txid: '2d3892ecdcceec467a47186f8abf081e58ce1080c36825d7f5fad3e731f4d791',
    vout: 1,
    value: 64864,
  };

  for (let i = 1; i < images.length; i++) {
    try {
      const result = await inscribeOne(images[i], currentUtxo);
      results.push(result);
      if (result.changeUtxo) {
        currentUtxo = result.changeUtxo;
      } else { break; }
      if (i < images.length - 1) {
        console.log('Waiting 15s...');
        await sleep(15000);
      }
    } catch (err) {
      console.error(`Failed on ${images[i].id}: ${err.message}`);
      console.log('Waiting 25s and retrying...');
      await sleep(25000);
      try {
        const result = await inscribeOne(images[i], currentUtxo);
        results.push(result);
        if (result.changeUtxo) currentUtxo = result.changeUtxo;
        if (i < images.length - 1) await sleep(15000);
      } catch (err2) {
        console.error(`Retry failed: ${err2.message}`);
        break;
      }
    }
  }

  const output = {
    timestamp: new Date().toISOString(),
    network: 'mainnet',
    version: 'v2-700px-q70',
    feeRate: FEE_RATE,
    fundingAddress: fundingPayment.address,
    taprootAddress: taprootPayment.address,
    inscriptions: results,
  };

  writeFileSync('.data/inscription-results-v2.json', JSON.stringify(output, null, 2));
  console.log('\n=== ALL RESULTS ===');
  results.forEach(r => console.log(`${r.id}: ${r.inscriptionId}`));
  console.log(`Total cost: ${results.reduce((s,r) => s + r.costSats, 0)} sats`);
}

main().catch(console.error);
