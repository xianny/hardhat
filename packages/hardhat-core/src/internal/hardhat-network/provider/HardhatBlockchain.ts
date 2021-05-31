import { Block } from "@ethereumjs/block";
import { TypedTransaction } from "@ethereumjs/tx";
import { BN, zeros } from "ethereumjs-util";

import { BlockchainData } from "./BlockchainData";
import { FilterParams } from "./node-types";
import { RpcLogOutput, RpcReceiptOutput } from "./output";
import {
  BlockRange,
  HardhatBlockchainInterface,
} from "./types/HardhatBlockchainInterface";

/* tslint:disable only-hardhat-error */
class BlockRangeManager {
  private _data: BlockRange[] = new Array(); // start block -> blockRange; ascending order

  constructor(private readonly _blockchainData: BlockchainData) {}

  public addRange(range: BlockRange): void {
    const last = this._data[this._data.length - 1];
    if (range.start.lte(last.end)) {
      throw new Error(
        `Invalid block range. Range must start after latest block. Expected start greater than ${last.end}; received ${range.start}`
      );
    }
    this._data.push(range);
  }

  public async getBlock(blockNumber: BN): Promise<Block | undefined> {
    const rIndex = this._data.findIndex(({ start, end }) => {
      return blockNumber.gte(start) && blockNumber.lte(end);
    });
    if (rIndex === -1) {
      return undefined;
    }
    const range = this._data[rIndex];
    const newBlock = await this._createBlockInRange(blockNumber, range);
    const totalDifficulty = this._computeTotalDifficulty(newBlock);
    this._blockchainData.addBlock(newBlock, totalDifficulty);

    let newRanges: BlockRange[] = [];
    const one = new BN(1);
    if (range.start.eq(blockNumber)) {
      newRanges = [
        {
          ...range,
          start: blockNumber.add(one),
          startTimestamp: range.startTimestamp.add(new BN(range.interval)),
        },
      ];
    } else if (range.end.eq(blockNumber)) {
      newRanges = [
        {
          ...range,
          end: range.end.sub(one),
        },
      ];
    } else {
      newRanges = [
        {
          ...range,
          end: blockNumber.sub(one),
        },
        {
          ...range,
          start: blockNumber.add(one),
          startTimestamp: newBlock.header.timestamp.add(new BN(range.interval)),
        },
      ];
    }
    this._data.splice(rIndex, 1, ...newRanges);
    return newBlock;
  }

  private async _createBlockInRange(
    blockNumber: BN,
    range: BlockRange
  ): Promise<Block> {
    const parent = this._blockchainData.getBlockByNumber(
      blockNumber.sub(new BN(1))
    );
    const header = {
      coinbase: range.coinbaseAddress,
      nonce: "0x0000000000000042",
      timestamp: blockNumber
        .sub(range.start)
        .mul(new BN(range.interval))
        .add(range.startTimestamp), // todo (xianny): check order of operations
      parentHash: parent?.hash(),
      stateRoot: range.stateRoot,
    };
    return Block.fromBlockData({ header });
  }

  // copypasta
  private _computeTotalDifficulty(block: Block): BN {
    const difficulty = new BN(block.header.difficulty);
    if (block.header.parentHash.equals(zeros(32))) {
      return difficulty;
    }
    const parentTD = this._blockchainData.getTotalDifficulty(
      block.header.parentHash
    );
    if (parentTD === undefined) {
      throw new Error("This should never happen");
    }
    return parentTD.add(difficulty);
  }
}
export class HardhatBlockchain implements HardhatBlockchainInterface {
  private readonly _data = new BlockchainData();
  private _length = 0;
  private readonly _blockRangeManager = new BlockRangeManager(this._data);

  public async getLatestBlock(): Promise<Block> {
    const latestBlockNumber = new BN(this._length - 1);
    const block = this._data.getBlockByNumber(latestBlockNumber);
    if (block !== undefined) {
      return block;
    }
    const blockIfInRange = await this._blockRangeManager.getBlock(
      latestBlockNumber
    );
    if (blockIfInRange === undefined) {
      throw new Error("No block available");
    }
    return blockIfInRange;
  }

  public async getBlock(
    blockHashOrNumber: Buffer | BN | number
  ): Promise<Block | null> {
    const isNumber = typeof blockHashOrNumber === "number";
    const isBN = BN.isBN(blockHashOrNumber);
    if (!isNumber && !isBN) {
      return this._data.getBlockByHash(blockHashOrNumber as Buffer) ?? null;
    }
    const blockNumber: BN = isNumber
      ? new BN(blockHashOrNumber)
      : (blockHashOrNumber as BN);
    return (
      this._data.getBlockByNumber(blockNumber) ??
      (await this._blockRangeManager.getBlock(blockNumber)) ??
      null
    );
  }

  public async addBlock(block: Block): Promise<Block> {
    this._validateBlock(block);
    const totalDifficulty = this._computeTotalDifficulty(block);
    this._data.addBlock(block, totalDifficulty);
    this._length += 1;
    return block;
  }

  public addBlockRange(range: BlockRange): void {
    // todo (xianny): check against latest block too?
    if (!range.start.eq(new BN(this._length))) {
      throw new Error(
        `Invalid block range: expected start block number ${this._length}, received ${range.start}`
      );
    }
    this._blockRangeManager.addRange(range);
    this._length = range.end.add(new BN(1)).toNumber();
  }

  public async putBlock(block: Block): Promise<void> {
    await this.addBlock(block);
  }

  public deleteBlock(blockHash: Buffer) {
    const block = this._data.getBlockByHash(blockHash);
    if (block === undefined) {
      throw new Error("Block not found");
    }
    this._delBlock(block);
  }

  public async delBlock(blockHash: Buffer) {
    this.deleteBlock(blockHash);
  }

  public deleteLaterBlocks(block: Block): void {
    const actual = this._data.getBlockByHash(block.hash());
    if (actual === undefined) {
      throw new Error("Invalid block");
    }
    const nextBlock = this._data.getBlockByNumber(
      new BN(actual.header.number).addn(1)
    );
    if (nextBlock !== undefined) {
      this._delBlock(nextBlock);
    }
  }

  public async getTotalDifficulty(blockHash: Buffer): Promise<BN> {
    const totalDifficulty = this._data.getTotalDifficulty(blockHash);
    if (totalDifficulty === undefined) {
      throw new Error("Block not found");
    }
    return totalDifficulty;
  }

  public async getTransaction(
    transactionHash: Buffer
  ): Promise<TypedTransaction | undefined> {
    return this.getLocalTransaction(transactionHash);
  }

  public getLocalTransaction(
    transactionHash: Buffer
  ): TypedTransaction | undefined {
    return this._data.getTransaction(transactionHash);
  }

  public async getBlockByTransactionHash(
    transactionHash: Buffer
  ): Promise<Block | null> {
    const block = this._data.getBlockByTransactionHash(transactionHash);
    return block ?? null;
  }

  public async getTransactionReceipt(transactionHash: Buffer) {
    return this._data.getTransactionReceipt(transactionHash) ?? null;
  }

  public addTransactionReceipts(receipts: RpcReceiptOutput[]) {
    for (const receipt of receipts) {
      this._data.addTransactionReceipt(receipt);
    }
  }

  public async getLogs(filterParams: FilterParams): Promise<RpcLogOutput[]> {
    return this._data.getLogs(filterParams);
  }

  public iterator(
    _name: string,
    _onBlock: (block: Block, reorg: boolean) => void | Promise<void>
  ): Promise<number | void> {
    throw new Error("Method not implemented.");
  }

  private _validateBlock(block: Block) {
    const blockNumber = block.header.number.toNumber();
    const parentHash = block.header.parentHash;
    const parent = this._data.getBlockByNumber(new BN(blockNumber - 1));

    if (this._length !== blockNumber) {
      throw new Error("Invalid block number");
    }
    if (
      (blockNumber === 0 && !parentHash.equals(zeros(32))) ||
      (blockNumber > 0 &&
        parent !== undefined &&
        !parentHash.equals(parent.hash()))
    ) {
      throw new Error("Invalid parent hash");
    }
  }

  private _computeTotalDifficulty(block: Block): BN {
    const difficulty = new BN(block.header.difficulty);
    if (block.header.parentHash.equals(zeros(32))) {
      return difficulty;
    }
    const parentTD = this._data.getTotalDifficulty(block.header.parentHash);
    if (parentTD === undefined) {
      throw new Error("This should never happen");
    }
    return parentTD.add(difficulty);
  }

  private _delBlock(block: Block): void {
    const blockNumber = block.header.number.toNumber();
    for (let i = blockNumber; i < this._length; i++) {
      const current = this._data.getBlockByNumber(new BN(i));
      if (current !== undefined) {
        this._data.removeBlock(current);
      }
    }
    this._length = blockNumber;
  }
}
