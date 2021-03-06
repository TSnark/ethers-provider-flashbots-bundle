import { BigNumber, ethers, providers, Signer } from "ethers";
import { TransactionRequest, TransactionReceipt } from "@ethersproject/abstract-provider";
import { BaseProvider } from "@ethersproject/providers";
import { ConnectionInfo } from "@ethersproject/web";
import { Networkish } from "@ethersproject/networks";

export enum FlashbotsBundleResolution {
  BundleIncluded,
  BlockPassedWithoutInclusion,
  AccountNonceTooHigh,
}

export interface FlashbotsBundleRawTransaction {
  signedTransaction: string
}

export interface FlashbotsBundleTransaction {
  transaction: TransactionRequest
  signer: Signer
}

interface TransactionAccountNonce {
  hash: string;
  signedTransaction: string;
  account: string;
  nonce: number
}

interface FlashbotsTransactionResponse {
  bundleTransactions: Array<TransactionAccountNonce>
  wait: () => Promise<FlashbotsBundleResolution>
  simulate: () => void
  receipts: () => Promise<Array<TransactionReceipt>>
}


interface SimulationResponse { // eslint-disable-line @typescript-eslint/no-empty-interface
  // TODO
}

const TIMEOUT_MS = 5 * 60 * 1000;

export class FlashbotsBundleProvider extends providers.JsonRpcProvider {
  private genericProvider: BaseProvider;

  constructor(genericProvider: BaseProvider, url?: ConnectionInfo | string, network?: Networkish) {
    super(url, network);
    this.genericProvider = genericProvider;
  }

  async sendRawBundle(signedBundledTransactions: Array<string>, targetBlockNumber: number): Promise<FlashbotsTransactionResponse> {
    await this.send("eth_sendBundle", [signedBundledTransactions, `0x${targetBlockNumber.toString(16)}`]);
    const bundleTransactions = signedBundledTransactions.map(signedTransaction => {
      const transactionDetails = ethers.utils.parseTransaction(signedTransaction)
      return {
        signedTransaction,
        hash: ethers.utils.keccak256(signedTransaction),
        account: transactionDetails.from || "0x0",
        nonce: transactionDetails.nonce
      }
    })
    console.log(bundleTransactions)
    return {
      bundleTransactions,
      wait: () => this.wait(bundleTransactions, targetBlockNumber,  TIMEOUT_MS),
      simulate: () => this.simulate(bundleTransactions, targetBlockNumber),
      receipts: () => this.fetchReceipts(bundleTransactions)
    }
  }

  async sendBundle(bundledTransactions: Array<FlashbotsBundleTransaction | FlashbotsBundleRawTransaction>, targetBlockNumber: number): Promise<FlashbotsTransactionResponse> {
    const nonces: { [address: string]: BigNumber } = {}
    const signedTransactions = new Array<string>()
    for (const tx of bundledTransactions) {
      if ("signedTransaction" in tx) {
        // in case someone is mixing pre-signed and signing transactions, decode to add to nonce object
        const transactionDetails = ethers.utils.parseTransaction(tx.signedTransaction)
        if (transactionDetails.from === undefined) throw new Error("Could not decode signed transaction")
        nonces[transactionDetails.from] = BigNumber.from(transactionDetails.nonce + 1)
        signedTransactions.push(tx.signedTransaction)
        continue
      }
      const transaction = {...tx.transaction}
      const address = await tx.signer.getAddress()
      if (typeof transaction.nonce === 'string') throw new Error("Bad nonce")
      const nonce = transaction.nonce !== undefined ? BigNumber.from(transaction.nonce) : nonces[address] || BigNumber.from(await this.genericProvider.getTransactionCount(address, "latest"))
      nonces[address] = nonce.add(1)
      if (transaction.nonce === undefined) transaction.nonce = nonce
      if (transaction.gasPrice === undefined) transaction.gasPrice = BigNumber.from(0)
      if (transaction.gasLimit === undefined) transaction.gasLimit = await tx.signer.estimateGas(transaction) // TODO: Add target block number and timestamp when supported by geth
      signedTransactions.push(await tx.signer.signTransaction(transaction))
    }
    return this.sendRawBundle(signedTransactions, targetBlockNumber)
  }

  private wait(transactionAccountNonces: Array<TransactionAccountNonce>, targetBlockNumber: number, timeout: number) {
    return new Promise<FlashbotsBundleResolution>((resolve, reject) => {
      let timer: NodeJS.Timer | null = null;
      let done = false;

      const minimumNonceByAccount = transactionAccountNonces.reduce((acc, accountNonce) => {
        if (accountNonce.nonce > 0 && (accountNonce.nonce || 0) < acc[accountNonce.account]) {
          acc[accountNonce.account] = accountNonce.nonce
        }
        acc[accountNonce.account] = accountNonce.nonce
        return acc
      }, {} as { [account: string]: number })
      const handler = async (blockNumber: number) => {
        console.log(`blockNumber: ${blockNumber} / ${targetBlockNumber}`)

        if (blockNumber < targetBlockNumber) {
          const noncesValid = await Promise.all(
            Object.entries(minimumNonceByAccount).map(async ([account, nonce]) => {
              const transactionCount = await this.genericProvider.getTransactionCount(account);
              return nonce >= transactionCount
            })
          );
          const allNoncesValid = noncesValid.every(Boolean);
          if (allNoncesValid) return;
          // target block not yet reached, but nonce has become invalid
          resolve(FlashbotsBundleResolution.AccountNonceTooHigh)
        } else {
          const block = await this.genericProvider.getBlock(targetBlockNumber);
          // check bundle against block:
          const bundleIncluded = transactionAccountNonces.every((transaction, i) =>
            block.transactions[block.transactions.length - 1 - i] === transaction.hash
          )
          resolve(bundleIncluded ? FlashbotsBundleResolution.BundleIncluded : FlashbotsBundleResolution.BlockPassedWithoutInclusion);
        }

        if (timer) { clearTimeout(timer);}
        if (done) {return;}
        done = true;

        this.genericProvider.removeListener('block', handler);
      }
      this.genericProvider.on('block', handler);

      if (typeof (timeout) === "number" && timeout > 0) {
        timer = setTimeout(() => {
          if (done) {
            return;
          }
          timer = null;
          done = true;

          this.genericProvider.removeListener('block', handler);
          reject("Timed out");
        }, timeout);
        if (timer.unref) {
          timer.unref();
        }
      }
    });
  }

  simulate(bundledTransactions: Array<FlashbotsBundleTransaction | FlashbotsBundleRawTransaction>, targetBlockNumber: number): Promise<Array<SimulationResponse>> {
    // TODO simulate
    console.error("Running simulation on " + bundledTransactions.length + " transactions on blockNumber " + targetBlockNumber)
    throw new Error("Simulation not yet supported")
  }

  private async fetchReceipts(bundledTransactions: Array<TransactionAccountNonce>): Promise<Array<TransactionReceipt>> {
    return Promise.all(bundledTransactions.map(bundledTransaction => this.genericProvider.getTransactionReceipt(bundledTransaction.hash)));
  }
}
