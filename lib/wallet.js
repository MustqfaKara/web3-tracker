// Cuzdan takibi: Alchemy (Base) + Etherscan (Ethereum) ile tx aliminm tx hash'e
// gore gruplama ve Telegram bildirim. Scam filter + min USD filter + cuzdan isimleri.
import { env, walletDisplayName } from './config.js';
import { processedTransfers, addToSetCapped } from './state.js';
import { sendText, telegramEscape } from './telegram.js';
import { getEthPrice, formatUsd } from './price.js';
import { isLegitimateToken, transferUsdValue } from './scam.js';
import { unitsToNumber } from './opensea.js';
import { recordError } from './errors.js';
import { createLogger } from './logger.js';
import { fetchWithTimeout } from './http.js';

const log = createLogger('wallet');

let isFirstWalletPoll = true;
let walletTimer = null;

// --- Alchemy poll (Base ag icin) ---
async function pollAlchemy(network, direction, address) {
  if (!env.ALCHEMY_API_KEY) return [];
  const baseUrl = network === 'base'
    ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  const params = {
    category: ['external', 'internal', 'erc20', 'erc721'],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: '0x14',
    order: 'desc'
  };
  if (direction === 'from') params.fromAddress = address;
  else params.toAddress = address;

  try {
    const res = await fetchWithTimeout(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [params]
      })
    });
    const data = await res.json();
    if (data.result && data.result.transfers) {
      return data.result.transfers.map(tx => ({ ...tx, network }));
    }
    if (data.error) log.warn(`Alchemy: ${data.error.message}`);
  } catch (e) {
    log.error(`Alchemy: ${e.message}`);
    recordError('alchemy', e);
  }
  return [];
}

// --- Etherscan poll (Ethereum ag icin) ---
async function pollEtherscan(action, address) {
  if (!env.ETHERSCAN_API_KEY || !address) return [];
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=${action}&address=${address}&startblock=0&endblock=99999999&page=1&offset=20&sort=desc&apikey=${env.ETHERSCAN_API_KEY}`;
  try {
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.status === '1' && data.result) {
      return data.result.map(tx => ({ ...tx, action_type: action }));
    }
    if (data.status === '0' && data.message !== 'No transactions found') {
      log.warn(`Etherscan ${action}: ${data.result}`);
    }
  } catch (e) {
    log.error(`Etherscan ${action}: ${e.message}`);
    recordError('etherscan', e);
  }
  return [];
}

// Etherscan tx'lerini Alchemy formatina cevir (uniform shape)
function normalizeEtherscan(tx, category) {
  const decimals = tx.tokenDecimal ? Number(tx.tokenDecimal) : 18;
  const val = unitsToNumber(tx.value, decimals);
  let fee = null;
  if (tx.gasPrice && tx.gasUsed) {
    const feeWei = BigInt(tx.gasPrice) * BigInt(tx.gasUsed);
    fee = unitsToNumber(feeWei.toString(), 18);
  }
  return {
    hash: tx.hash,
    network: 'ethereum',
    category,
    asset: tx.tokenSymbol || 'ETH',
    value: val,
    to: tx.to,
    from: tx.from,
    tokenId: tx.tokenID,
    contractAddress: tx.contractAddress,
    fee,
    metadata: { blockTimestamp: new Date(Number(tx.timeStamp) * 1000).toISOString() }
  };
}

async function pollAddress(address) {
  const [baseFrom, baseTo] = await Promise.all([
    pollAlchemy('base', 'from', address),
    pollAlchemy('base', 'to', address)
  ]);

  // Etherscan rate-limit'i koruyalim — aralarinda kucuk gap
  const ethNormal = await pollEtherscan('txlist', address);
  await new Promise(r => setTimeout(r, 250));
  const ethInternal = await pollEtherscan('txlistinternal', address);
  await new Promise(r => setTimeout(r, 250));
  const ethErc20 = await pollEtherscan('tokentx', address);
  await new Promise(r => setTimeout(r, 250));
  const ethNft = await pollEtherscan('tokennfttx', address);

  log.debug(`${address}: ETH ${ethNormal.length + ethInternal.length + ethErc20.length + ethNft.length} | Base ${baseFrom.length + baseTo.length}`);

  return [
    ...ethNormal.map(tx => normalizeEtherscan(tx, 'external')),
    ...ethInternal.map(tx => normalizeEtherscan(tx, 'internal')),
    ...ethErc20.map(tx => normalizeEtherscan(tx, 'erc20')),
    ...ethNft.map(tx => normalizeEtherscan(tx, 'erc721')),
    ...baseFrom,
    ...baseTo
  ];
}

// Tx'leri hash'e gore grupla — bir tx'in farkli kategorideki transfer'lari tek mesajda
function groupTransfers(transfers) {
  const groups = {};
  for (const tx of transfers) {
    if (!tx.hash) continue;
    const key = `${tx.network}-${tx.hash}`;
    const ts = tx.metadata?.blockTimestamp
      ? new Date(tx.metadata.blockTimestamp).getTime() / 1000
      : 0;
    if (!groups[key]) groups[key] = { hash: tx.hash, network: tx.network, transfers: [], timeStamp: ts };
    groups[key].transfers.push(tx);
  }
  return groups;
}

function uniqueIdOf(tx) {
  return `${tx.network}-${tx.hash}-${tx.category}-${tx.value || 0}-${tx.tokenId || 0}`;
}

async function buildAndSendMessage(group, address) {
  const me = address.toLowerCase();
  const networkIcon = group.network === 'base' ? '🔵' : '🔷';
  const networkName = group.network === 'base' ? 'Base' : 'Ethereum';
  const explorerName = group.network === 'base' ? 'Basescan' : 'Etherscan';
  const walletName = walletDisplayName(me);

  let msg = `<b>${networkIcon} ${telegramEscape(walletName)} bir islem yapti</b>\n<i>${networkName}</i>\n\n`;
  const detailSet = new Set();
  const details = [];
  const nftLinks = [];
  let hasNew = false;
  let feeMsg = null;

  group.transfers.sort((a, b) => a.category.localeCompare(b.category));
  const ethPrice = await getEthPrice();

  for (const tx of group.transfers) {
    const uniqueId = uniqueIdOf(tx);
    if (processedTransfers.has(uniqueId)) continue;
    addToSetCapped(processedTransfers, uniqueId, 50000);
    hasNew = true;

    // Fee — sadece gonderen kendisiyse, ilk fee satirini al
    if (tx.fee !== null && tx.fee !== undefined && tx.from?.toLowerCase() === me && !feeMsg) {
      feeMsg = `💸 <b>Fee:</b> ${tx.fee} ETH${formatUsd(tx.fee, ethPrice)}`;
    }

    const val = tx.value !== null ? tx.value : 1;
    const rawAsset = tx.asset || 'Bilinmeyen Token';

    // Scam token filter — ERC20'lerde whitelist + Unicode kontrolu
    if (tx.category === 'erc20' && !isLegitimateToken(rawAsset)) continue;

    const asset = telegramEscape(rawAsset);

    if (tx.category === 'external' || tx.category === 'internal' || tx.category === 'erc20') {
      // Minimum USD value filter — dust transferleri ele
      const usd = transferUsdValue(val, tx.asset, ethPrice);
      if (usd !== null && usd < env.MIN_USD_VALUE) continue;

      const usdSfx = (tx.asset === 'ETH' || tx.asset === 'WETH') ? formatUsd(val, ethPrice) : '';

      let line = null;
      if (tx.to?.toLowerCase() === me) line = `🟢 <b>Gelen:</b> ${val} ${asset}${usdSfx}`;
      else if (tx.from?.toLowerCase() === me) line = `🔴 <b>Giden:</b> ${val} ${asset}${usdSfx}`;
      if (line && !detailSet.has(line)) {
        detailSet.add(line);
        details.push(line);
      }
    } else if (tx.category === 'erc721') {
      const tokenIdHex = tx.tokenId || tx.erc721TokenId;
      const tokenIdDec = telegramEscape(tokenIdHex ? BigInt(tokenIdHex).toString() : 'Bilinmeyen');
      const contractAddr = tx.contractAddress || tx.rawContract?.address;
      if (contractAddr && tokenIdDec !== 'Bilinmeyen') {
        const chainPrefix = tx.network === 'base' ? 'base' : 'ethereum';
        const nftLine = `<a href="https://opensea.io/assets/${chainPrefix}/${contractAddr}/${tokenIdDec}">OpenSea'de Goruntule (#${tokenIdDec})</a>`;
        if (!detailSet.has(nftLine)) {
          detailSet.add(nftLine);
          nftLinks.push(nftLine);
        }
      }
      let line = null;
      if (tx.to?.toLowerCase() === me) line = `🖼️ <b>NFT Alindi:</b> ${asset} #${tokenIdDec}`;
      else if (tx.from?.toLowerCase() === me) line = `🖼️ <b>NFT Satildi:</b> ${asset} #${tokenIdDec}`;
      if (line && !detailSet.has(line)) {
        detailSet.add(line);
        details.push(line);
      }
    }
  }

  const explorerLink = group.network === 'base'
    ? `https://basescan.org/tx/${group.hash}`
    : `https://etherscan.io/tx/${group.hash}`;

  if (hasNew && details.length > 0) {
    msg += details.join('\n');
    if (feeMsg) msg += `\n${feeMsg}`;
    if (nftLinks.length > 0) msg += `\n\n${nftLinks.join('\n')}`;
    msg += `\n\n<a href="${explorerLink}">${explorerName}'de Goruntule</a>`;
    log.info(`${walletName} ${group.network} ${group.hash.slice(0, 10)}...`);
    recordError('wallet_tx', null, { wallet: walletName, network: group.network, hash: group.hash, explorerLink });
    if (env.DRY_RUN) {
      log.info('[dry-run] wallet bildirim atlandi');
    } else {
      await sendText(msg, env.TELEGRAM_WALLET_THREAD_ID);
    }
  }
}

export async function pollWalletTransactions() {
  for (const address of env.WALLET_ADDRESSES) {
    try {
      const all = await pollAddress(address);
      const groups = groupTransfers(all);
      const nowSecs = Math.floor(Date.now() / 1000);

      for (const key in groups) {
        const group = groups[key];

        // 600s'den eski tx'leri sessizce seen olarak isaretle
        if (group.timeStamp < nowSecs - 600) {
          for (const tx of group.transfers) {
            addToSetCapped(processedTransfers, uniqueIdOf(tx), 50000);
          }
          continue;
        }

        // Ilk poll'da tum recent tx'leri de bildirim ATMADAN seen isaretle
        // (bot her yeniden baslatildiginda gecmis tx'leri tekrar Telegram'a vermesin)
        if (isFirstWalletPoll) {
          for (const tx of group.transfers) {
            addToSetCapped(processedTransfers, uniqueIdOf(tx), 50000);
          }
          continue;
        }

        await buildAndSendMessage(group, address);
      }
    } catch (e) {
      log.error(`Address ${address}: ${e.message}`);
      recordError('wallet_poll', e);
    }
  }
  isFirstWalletPoll = false;
}

export function startWalletWatcher() {
  if (env.WALLET_ADDRESSES.length === 0 || (!env.ALCHEMY_API_KEY && !env.ETHERSCAN_API_KEY)) {
    log.info('Wallet tracking disabled (adres yok veya Alchemy/Etherscan key yok)');
    return;
  }
  const networks = [
    env.ALCHEMY_API_KEY ? 'Base/Alchemy' : null,
    env.ETHERSCAN_API_KEY ? 'Ethereum/Etherscan' : null
  ].filter(Boolean).join(' + ');
  log.info(`Wallet tracker: ${env.WALLET_ADDRESSES.length} cuzdan, ${networks}, ${env.WALLET_POLL_INTERVAL_MS / 1000}s araliklarla`);
  walletTimer = setInterval(pollWalletTransactions, env.WALLET_POLL_INTERVAL_MS);
  pollWalletTransactions();
}

export function stopWalletWatcher() {
  if (walletTimer) {
    clearInterval(walletTimer);
    walletTimer = null;
  }
}
