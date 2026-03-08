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

// Derive keys
const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);

// BIP84 funding key
const bip84 = root.derive("m/84'/0'/0'/0/0");
const fundingPrivKey = new Uint8Array(bip84.privateKey);
const fundingPub = bip84.publicKey;
const fundingPayment = btc.p2wpkh(fundingPub, network);

// BIP86 taproot receive key
const bip86 = root.derive("m/86'/0'/0'/0/0");
const taprootPrivKey = new Uint8Array(bip86.privateKey);
const taprootPubKey = bip86.publicKey.slice(1); // x-only 32 bytes
const taprootPayment = btc.p2tr(taprootPubKey, undefined, network);

console.log('Funding address:', fundingPayment.address);
console.log('Taproot address:', taprootPayment.address);

// Images to inscribe (order: smallest first to preserve sats for larger ones)
const images = [
  { id: 'seed-2', title: 'Governance Proposal #47', file: '.data/inscription-webp-v2/seed-2-composed.webp' },
  { id: 'seed-1', title: 'The sBTC Bridge Opens', file: '.data/inscription-webp-v2/seed-1-composed.webp' },
  { id: 'seed-3', title: 'Clarity Smart Contract Audit', file: '.data/inscription-webp-v2/seed-3-composed.webp' },
  { id: 'cartoon-btc-agents', title: 'AI Agents Prefer Bitcoin', file: '.data/inscription-webp-v2/cartoon-btc-agents-composed.webp' },
  { id: 'cartoon-cafeteria', title: 'Block Layoffs', file: '.data/inscription-webp-v2/cartoon-cafeteria-composed.webp' },
];

async function fetchUtxos(address) {
  const res = await fetch(`https://mempool.space/api/address/${address}/utxo`);
  return await res.json();
}

async function broadcast(txHex) {
  const res = await fetch('https://mempool.space/api/tx', {
    method: 'POST',
    body: txHex,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broadcast failed: ${err}`);
  }
  return await res.text();
}

function addressToScript(addr, net) {
  // Use btc.Address(net).decode(addr) to get the script
  return btc.Address(net).decode(addr);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function inscribeOne(image, utxo) {
  console.log(`\n--- Inscribing ${image.id} ---`);
  const imageData = readFileSync(image.file);
  console.log(`Image size: ${imageData.length} bytes`);

  // Build inscription
  const inscription = {
    tags: { contentType: 'image/webp' },
    body: new Uint8Array(imageData),
  };

  const reveal = p2tr_ord_reveal(taprootPubKey, [inscription]);
  const inscriptionPayment = btc.p2tr(
    NUMS_KEY,
    { script: reveal.script },
    network,
    true,
    [OutOrdinalReveal]
  );

  console.log('Inscription address:', inscriptionPayment.address);

  // Estimate reveal tx size: ~overhead + image size / 4 (witness discount)
  const revealVSize = Math.ceil(100 + imageData.length / 4);
  const revealFee = revealVSize * FEE_RATE;
  const inscriptionAmount = BigInt(546 + revealFee);

  // Build commit tx
  const commitTx = new btc.Transaction({ allowUnknownOutputs: true });
  commitTx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: fundingPayment.script,
      amount: BigInt(utxo.value),
    },
  });

  // Output 0: fund the inscription address
  commitTx.addOutputAddress(inscriptionPayment.address, inscriptionAmount, network);

  // Estimate commit vsize for fee
  const commitEstVSize = 110 + 40; // 1-in-2-out P2WPKH ~150 vbytes
  const commitFee = BigInt(commitEstVSize * FEE_RATE);
  const change = BigInt(utxo.value) - inscriptionAmount - commitFee;

  if (change > 546n) {
    commitTx.addOutputAddress(fundingPayment.address, change, network);
    console.log(`Change: ${change} sats`);
  } else {
    console.log(`No change output (dust: ${change})`);
  }

  commitTx.sign(fundingPrivKey);
  commitTx.finalize();
  const commitHex = hex.encode(commitTx.extract());
  const commitTxid = await broadcast(commitHex);
  console.log(`Commit txid: ${commitTxid}`);

  // Wait for propagation
  await sleep(3000);

  // Build reveal tx
  const revealTx = new btc.Transaction({
    allowUnknownOutputs: true,
    customScripts: [OutOrdinalReveal],
  });

  revealTx.addInput({
    txid: commitTxid,
    index: 0,
    witnessUtxo: {
      script: inscriptionPayment.script,
      amount: inscriptionAmount,
    },
    tapLeafScript: inscriptionPayment.tapLeafScript,
  });

  // Output: 546 sat dust to taproot address (the inscription UTXO)
  revealTx.addOutput({
    script: addressToScript(taprootPayment.address, network),
    amount: 546n,
  });

  revealTx.sign(taprootPrivKey);
  revealTx.finalize();
  const revealHex = hex.encode(revealTx.extract());
  const revealTxid = await broadcast(revealHex);
  console.log(`Reveal txid: ${revealTxid}`);
  console.log(`Inscription ID: ${revealTxid}i0`);

  const costSats = Number(inscriptionAmount) + Number(commitFee);
  console.log(`Cost: ${costSats} sats`);

  return {
    id: image.id,
    title: image.title,
    inscriptionId: `${revealTxid}i0`,
    commitTxid,
    revealTxid,
    costSats,
    changeUtxo: change > 546n ? { txid: commitTxid, vout: 1, value: Number(change) } : null,
  };
}

async function main() {
  // Get current UTXOs
  const utxos = await fetchUtxos(fundingPayment.address);
  console.log('UTXOs:', utxos.map(u => `${u.txid.slice(0,8)}...:${u.vout} = ${u.value} sats`));

  // Combine into largest first
  const sortedUtxos = utxos.sort((a, b) => b.value - a.value);
  let currentUtxo = sortedUtxos[0];

  // If multiple UTXOs, consolidate by using the largest one
  // But we might need to use both. Let's just start with the largest.
  if (sortedUtxos.length > 1 && sortedUtxos[0].value < 60000) {
    // Consolidate UTXOs first
    console.log('Consolidating UTXOs...');
    const consolidateTx = new btc.Transaction({ allowUnknownOutputs: true });
    let totalIn = 0n;
    for (const u of sortedUtxos) {
      consolidateTx.addInput({
        txid: u.txid,
        index: u.vout,
        witnessUtxo: {
          script: fundingPayment.script,
          amount: BigInt(u.value),
        },
      });
      totalIn += BigInt(u.value);
    }
    const consolFee = BigInt(Math.ceil((68 * sortedUtxos.length + 31 + 10) * FEE_RATE));
    consolidateTx.addOutputAddress(fundingPayment.address, totalIn - consolFee, network);
    consolidateTx.sign(fundingPrivKey);
    consolidateTx.finalize();
    const consolHex = hex.encode(consolidateTx.extract());
    const consolTxid = await broadcast(consolHex);
    console.log(`Consolidation txid: ${consolTxid}`);
    await sleep(5000);
    currentUtxo = { txid: consolTxid, vout: 0, value: Number(totalIn - consolFee) };
  }

  console.log(`Starting with UTXO: ${currentUtxo.txid.slice(0,16)}... value=${currentUtxo.value} sats`);

  const results = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];

    try {
      const result = await inscribeOne(image, currentUtxo);
      results.push(result);

      if (result.changeUtxo) {
        currentUtxo = result.changeUtxo;
        console.log(`Next UTXO: ${currentUtxo.txid.slice(0,16)}... value=${currentUtxo.value} sats`);
      } else {
        console.log('No change UTXO, stopping.');
        break;
      }

      // Wait between inscriptions to avoid RBF conflicts
      if (i < images.length - 1) {
        console.log('Waiting 15s for mempool propagation...');
        await sleep(15000);
      }
    } catch (err) {
      console.error(`Failed on ${image.id}: ${err.message}`);
      // Wait and retry once
      console.log('Waiting 25s and retrying...');
      await sleep(25000);
      try {
        const result = await inscribeOne(image, currentUtxo);
        results.push(result);
        if (result.changeUtxo) {
          currentUtxo = result.changeUtxo;
        }
        if (i < images.length - 1) await sleep(15000);
      } catch (err2) {
        console.error(`Retry failed on ${image.id}: ${err2.message}`);
        break;
      }
    }
  }

  // Save results
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
  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
