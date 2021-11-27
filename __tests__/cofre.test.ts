import { Provider, setProvider, workspace, BN } from "@project-serum/anchor";
import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import assert from "assert";

describe("cofre", () => {
  const provider = Provider.env();
  setProvider(provider);
  const program = workspace.Cofre;

  const maker = Keypair.generate();
  const taker = Keypair.generate();
  const mintAuthority = Keypair.generate();

  let mintA: Token;
  let mintB: Token;
  let mintC: Token;
  let makerTokenA: PublicKey;
  let makerTokenB: PublicKey;

  let takerTokenA: PublicKey;
  let takerTokenB: PublicKey;
  let takerTokenC: PublicKey;

  let makerAmount = 1;
  let takerAmount = 2;

  let escrowState: Keypair;
  let escrowVault: PublicKey;
  let vaultBump: number;

  beforeAll(async () => {
    // Airdropping Maker
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        maker.publicKey,
        100 * LAMPORTS_PER_SOL
      ),
      "confirmed"
    );

    // Airdropping Taker
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        taker.publicKey,
        100 * LAMPORTS_PER_SOL
      ),
      "confirmed"
    );

    // Airdropping Mint Authority
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        mintAuthority.publicKey,
        100 * LAMPORTS_PER_SOL
      ),
      "confirmed"
    );
  });

  async function initializeState() {
    mintA = await Token.createMint(
      provider.connection,
      maker,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    mintB = await Token.createMint(
      provider.connection,
      taker,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    mintC = await Token.createMint(
      provider.connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    makerTokenA = await mintA.createAssociatedTokenAccount(maker.publicKey);
    makerTokenB = await mintB.createAssociatedTokenAccount(maker.publicKey);

    takerTokenA = await mintA.createAssociatedTokenAccount(taker.publicKey);
    takerTokenB = await mintB.createAssociatedTokenAccount(taker.publicKey);
    takerTokenC = await mintC.createAssociatedTokenAccount(taker.publicKey);

    await mintA.mintTo(
      makerTokenA,
      mintAuthority.publicKey,
      [mintAuthority],
      makerAmount
    );

    await mintB.mintTo(
      takerTokenB,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    await mintC.mintTo(
      takerTokenC,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    escrowState = Keypair.generate();

    // Get the PDA that is assigned authority to token account.
    const [_pda, _bump] = await PublicKey.findProgramAddress(
      [escrowState.publicKey.toBuffer()],
      program.programId
    );

    escrowVault = _pda;
    vaultBump = _bump;

    let _makerTokenA = await mintA.getAccountInfo(makerTokenA);
    let _makerTokenB = await mintB.getAccountInfo(makerTokenB);

    let _takerTokenA = await mintA.getAccountInfo(takerTokenA);
    let _takerTokenB = await mintB.getAccountInfo(takerTokenB);
    let _takerTokenC = await mintC.getAccountInfo(takerTokenC);

    expect(_makerTokenA.owner).toEqual(maker.publicKey);
    expect(_makerTokenB.owner).toEqual(maker.publicKey);
    expect(_takerTokenA.owner).toEqual(taker.publicKey);
    expect(_takerTokenB.owner).toEqual(taker.publicKey);
    expect(_takerTokenC.owner).toEqual(taker.publicKey);

    expect(_makerTokenA.amount.toNumber()).toBe(makerAmount);
    expect(_takerTokenA.amount.toNumber()).toBe(0);
    expect(_makerTokenB.amount.toNumber()).toBe(0);
    expect(_takerTokenB.amount.toNumber()).toBe(takerAmount);
    expect(_takerTokenC.amount.toNumber()).toBe(takerAmount);
  }

  describe("SplSpl trade", () => {
    beforeAll(initializeState);

    it("Initialize", async () => {
      await program.rpc.initialize(
        new BN(makerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenA,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let _makerTokenA = await mintA.getAccountInfo(makerTokenA);
      let escrowVaultToken = await mintA.getAccountInfo(escrowVault);

      let escrowStateAccount = await program.account.escrowState.fetch(
        escrowState.publicKey
      );

      // Check that the owner of the maker account is still the maker
      assert.ok(_makerTokenA.owner.equals(maker.publicKey));

      // Check that the owner of the vault is the PDA.
      assert.ok(escrowVaultToken.owner.equals(escrowVault));
      assert.strictEqual(escrowVaultToken.amount.toNumber(), makerAmount);
      assert.ok(escrowVaultToken.mint.equals(mintA.publicKey));

      // Check that the values in the escrow account match what we expect.
      assert.ok(escrowStateAccount.maker.equals(maker.publicKey));
      assert.strictEqual(
        escrowStateAccount.makerAmount.toNumber(),
        makerAmount
      );
      assert.strictEqual(
        escrowStateAccount.takerAmount.toNumber(),
        takerAmount
      );
      assert.ok(escrowStateAccount.trade.splSpl.fromToken.equals(makerTokenA));
      assert.ok(
        escrowStateAccount.trade.splSpl.fromMint.equals(mintA.publicKey)
      );
      assert.ok(escrowStateAccount.trade.splSpl.toToken.equals(makerTokenB));
      assert.ok(escrowStateAccount.trade.splSpl.toMint.equals(mintB.publicKey));
      assert.ok(escrowStateAccount.vault.equals(escrowVault));
    });

    it("Invalid Exchange", async () => {
      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        program.rpc.exchange(new BN(vaultBump), {
          accounts: {
            taker: taker.publicKey,
            fromTakerAccount: takerTokenC,
            toTakerAccount: takerTokenA,
            maker: maker.publicKey,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          signers: [taker],
        }),
        (err: any) => {
          return err.logs.includes(
            "Program log: Error: Account not associated with this Mint"
          );
        }
      );
    });

    it("Exchange", async () => {
      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let stateBeforeEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let vaultBeforeEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );

      await program.rpc.exchange(new BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: takerTokenB,
          toTakerAccount: takerTokenA,
          maker: maker.publicKey,
          toMakerAccount: makerTokenB,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [taker],
      });

      let _makerTokenA = await mintA.getAccountInfo(makerTokenA);
      let _makerTokenB = await mintB.getAccountInfo(makerTokenB);

      let _takerTokenA = await mintA.getAccountInfo(takerTokenA);
      let _takerTokenB = await mintB.getAccountInfo(takerTokenB);

      let makerAfterEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let stateAfterEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let vaultAfterEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );

      // Check that the maker gets back ownership of their token account.
      assert.ok(_makerTokenA.owner.equals(maker.publicKey));
      assert.strictEqual(_makerTokenA.amount.toNumber(), 0);
      assert.strictEqual(_makerTokenB.amount.toNumber(), takerAmount);
      assert.strictEqual(_takerTokenA.amount.toNumber(), makerAmount);
      assert.strictEqual(_takerTokenB.amount.toNumber(), 0);

      // Check that escrowState and vault account is gone
      assert.strictEqual(stateAfterEscrow, null);
      assert.strictEqual(vaultAfterEscrow, null);
      assert.strictEqual(
        makerAfterEscrow!.lamports,
        makerBeforeEscrow!.lamports +
          stateBeforeEscrow!.lamports +
          vaultBeforeEscrow!.lamports
      );
    });

    it("Cancel", async () => {
      // Put back tokens into maker token A account.
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      await mintA.mintTo(
        makerTokenA,
        mintAuthority.publicKey,
        [mintAuthority],
        newMakerAmount
      );

      await program.rpc.initialize(
        new BN(newMakerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenA,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      // Cancel the escrow.
      await program.rpc.cancel(new BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: makerTokenA,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [maker],
      });

      let _makerTokenA = await mintA.getAccountInfo(makerTokenA);

      let escrowVaultAccountInfo = await provider.connection.getAccountInfo(
        escrowVault
      );
      let escrowStateAccountInfo = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );

      // Check all the funds were sent back there.
      assert.strictEqual(_makerTokenA.amount.toNumber(), newMakerAmount);

      // Check Vault and State are gone
      assert.strictEqual(escrowVaultAccountInfo, null);
      assert.strictEqual(escrowStateAccountInfo, null);
    });
  });

  describe("SolSpl trade", () => {
    beforeAll(initializeState);

    let makerAmountLamports: number;

    beforeAll(() => {
      makerAmountLamports = makerAmount * LAMPORTS_PER_SOL;
    });

    it("Initialize", async () => {
      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let transactionSignature = await program.rpc.initialize(
        new BN(makerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      let makerAccountInfo = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let escrowVaultAccountInfo = await provider.connection.getAccountInfo(
        escrowVault
      );
      let escrowStateAccountInfo = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let escrowStateAccount = await program.account.escrowState.fetch(
        escrowState.publicKey
      );

      // Check that the maker gave the amount, and paid for the escrowState
      assert.strictEqual(
        makerAccountInfo!.lamports,
        makerBeforeEscrow!.lamports -
          makerAmountLamports -
          escrowStateAccountInfo!.lamports
      );

      // Check that the vault holds the makerAmount
      assert.strictEqual(escrowVaultAccountInfo!.lamports, makerAmountLamports);

      // Check that the values in the escrow account match what we expect.
      assert.ok(escrowStateAccount.maker.equals(maker.publicKey));
      assert.strictEqual(
        escrowStateAccount.makerAmount.toNumber(),
        makerAmount
      );
      assert.strictEqual(
        escrowStateAccount.takerAmount.toNumber(),
        takerAmount
      );
      assert.ok(
        escrowStateAccount.trade.solSpl.fromNative.equals(maker.publicKey)
      );
      assert.ok(escrowStateAccount.trade.solSpl.toToken.equals(makerTokenB));
      assert.ok(escrowStateAccount.trade.solSpl.toMint.equals(mintB.publicKey));
      assert.ok(escrowStateAccount.vault.equals(escrowVault));
    });

    it("Invalid Exchange", async () => {
      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        program.rpc.exchange(new BN(vaultBump), {
          accounts: {
            taker: taker.publicKey,
            fromTakerAccount: takerTokenC,
            toTakerAccount: taker.publicKey,
            maker: maker.publicKey,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          signers: [taker],
        }),
        (err: any) => {
          // console.error(err)
          return err.logs.includes(
            "Program log: Error: Account not associated with this Mint"
          );
        }
      );
    });

    it("Exchange", async () => {
      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let takerBeforeEscrow = await provider.connection.getAccountInfo(
        taker.publicKey
      );
      let stateBeforeEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let vaultBeforeEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );
      let makerBeforeEscrowTokenB = await mintB.getAccountInfo(makerTokenB);

      assert.strictEqual(vaultBeforeEscrow!.lamports, makerAmountLamports);

      let transactionSignature = await program.rpc.exchange(new BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: takerTokenB,
          toTakerAccount: taker.publicKey,
          maker: maker.publicKey,
          toMakerAccount: makerTokenB,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [taker],
      });

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      let makerAccountInfo = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let makerAfterEscrowTokenB = await mintB.getAccountInfo(makerTokenB);

      let takerAfterEscrow = await provider.connection.getAccountInfo(
        taker.publicKey
      );
      let takerAfterTokenB = await mintB.getAccountInfo(takerTokenB);

      let makerAfterEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let stateAfterEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let vaultAfterEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );

      // Maker gets escrowState rent
      assert.strictEqual(
        makerAfterEscrow!.lamports,
        makerBeforeEscrow!.lamports + stateBeforeEscrow!.lamports
      );
      // Maker gets takerAmount of TokenB
      assert.strictEqual(
        makerAfterEscrowTokenB.amount.toNumber(),
        makerBeforeEscrowTokenB.amount.toNumber() + takerAmount
      );
      // Taker gets escrowVault lamports
      assert.strictEqual(
        takerAfterEscrow!.lamports,
        takerBeforeEscrow!.lamports + makerAmountLamports
      );
      // Taker loses takerAmount of TokenB
      assert.strictEqual(takerAfterTokenB.amount.toNumber(), 0);

      // Check that escrowState and escrowVault accounts are gone
      assert.strictEqual(stateAfterEscrow, null);
      assert.strictEqual(vaultAfterEscrow, null);
    });

    it("Cancel", async () => {
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      let newMakerAmountLamports = newMakerAmount * LAMPORTS_PER_SOL;

      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );

      await program.rpc.initialize(
        new BN(newMakerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let makerDuringEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let vaultDuringEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );
      let stateDuringEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );

      assert.strictEqual(
        makerDuringEscrow!.lamports,
        makerBeforeEscrow!.lamports -
          stateDuringEscrow!.lamports -
          vaultDuringEscrow!.lamports
      );
      assert.strictEqual(vaultDuringEscrow!.lamports, newMakerAmountLamports);

      // Cancel the escrow.
      await program.rpc.cancel(new BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [maker],
      });

      let makerAfterCancel = await provider.connection.getAccountInfo(
        maker.publicKey
      );

      // Check all the funds were sent back there.
      assert.strictEqual(
        makerBeforeEscrow!.lamports,
        makerAfterCancel!.lamports
      );
      assert.strictEqual(
        makerAfterCancel!.lamports,
        makerDuringEscrow!.lamports +
          vaultDuringEscrow!.lamports +
          stateDuringEscrow!.lamports
      );
    });
  });

  describe("SplSol trade", () => {
    beforeAll(initializeState);

    it("Initialize", async () => {
      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let transactionSignature = await program.rpc.initialize(
        new BN(makerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: makerTokenA,
            toMakerAccount: maker.publicKey,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintA.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      let makerAccountInfo = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let escrowVaultAccountInfo = await provider.connection.getAccountInfo(
        escrowVault
      );
      let escrowVaultToken = await mintA.getAccountInfo(escrowVault);
      let escrowStateAccountInfo = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      let escrowStateAccount = await program.account.escrowState.fetch(
        escrowState.publicKey
      );

      // Check that the maker gave the amount, and paid for the escrowState
      assert.strictEqual(
        makerAccountInfo!.lamports,
        makerBeforeEscrow!.lamports -
          escrowStateAccountInfo!.lamports -
          escrowVaultAccountInfo!.lamports
      );

      // Check that the vault holds the makerAmount of Token A
      assert.strictEqual(escrowVaultToken.amount.toNumber(), makerAmount);

      // Check that the values in the escrow account match what we expect.
      assert.ok(escrowStateAccount.maker.equals(maker.publicKey));
      assert.strictEqual(
        escrowStateAccount.makerAmount.toNumber(),
        makerAmount
      );
      assert.strictEqual(
        escrowStateAccount.takerAmount.toNumber(),
        takerAmount
      );
      assert.ok(
        escrowStateAccount.trade.splSol.toNative.equals(maker.publicKey)
      );
      assert.ok(escrowStateAccount.trade.splSol.fromToken.equals(makerTokenA));
      assert.ok(
        escrowStateAccount.trade.splSol.fromMint.equals(mintA.publicKey)
      );
      assert.ok(escrowStateAccount.vault.equals(escrowVault));
    });

    it("Invalid Exchange", async () => {
      // Try to Exchange with the wrong taker account mint
      await assert.rejects(
        program.rpc.exchange(new BN(vaultBump), {
          accounts: {
            taker: taker.publicKey,
            fromTakerAccount: taker.publicKey,
            toTakerAccount: takerTokenC, // NOTE This is the wrong account, it should hold lamports
            maker: maker.publicKey,
            toMakerAccount: maker.publicKey,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          signers: [taker],
        }),
        (err: any) => {
          // console.error(err)
          return err.logs.includes(
            "Program log: Error: Account not associated with this Mint"
          );
        }
      );
    });

    it("Exchange", async () => {
      const makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      const takerBeforeEscrow = await provider.connection.getAccountInfo(
        taker.publicKey
      );
      const stateAccountBeforeEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      const vaultAccountBeforeEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );

      const vaultBeforeEscrow = await mintA.getAccountInfo(escrowVault);
      const makerBeforeEscrowTokenA = await mintA.getAccountInfo(makerTokenA);
      const takerBeforeTokenA = await mintA.getAccountInfo(takerTokenA);

      assert.strictEqual(vaultBeforeEscrow!.amount.toNumber(), makerAmount);

      let transactionSignature = await program.rpc.exchange(new BN(vaultBump), {
        accounts: {
          taker: taker.publicKey,
          fromTakerAccount: taker.publicKey,
          toTakerAccount: takerTokenA,
          maker: maker.publicKey,
          toMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [taker],
      });

      await provider.connection.confirmTransaction(
        transactionSignature,
        "confirmed"
      );

      const takerAmountLamports = takerAmount * LAMPORTS_PER_SOL;

      const takerAfterEscrow = await provider.connection.getAccountInfo(
        taker.publicKey
      );
      const makerAfterEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      const stateAfterEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );
      const vaultAfterEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );

      const makerAfterEscrowTokenA = await mintA.getAccountInfo(makerTokenA);
      const takerAfterTokenA = await mintA.getAccountInfo(takerTokenA);

      // Maker gets escrowState rent + escrowVault rent
      assert.strictEqual(
        makerAfterEscrow!.lamports,
        makerBeforeEscrow!.lamports +
          stateAccountBeforeEscrow!.lamports +
          vaultAccountBeforeEscrow!.lamports +
          takerAmountLamports
      );

      // Taker gets makerAmount of TokenA
      assert.strictEqual(
        takerAfterTokenA.amount.toNumber(),
        takerBeforeTokenA.amount.toNumber() + makerAmount
      );
      // Taker loses takerAmountLamports lamports
      assert.strictEqual(
        takerAfterEscrow!.lamports,
        takerBeforeEscrow!.lamports - takerAmountLamports
      );

      // Check that escrowState and escrowVault accounts are gone
      assert.strictEqual(stateAfterEscrow, null);
      assert.strictEqual(vaultAfterEscrow, null);
    });

    it("Cancel", async () => {
      // For some reason we need to change a value otherwise repeating the transaction takes too long and expires mocha timeout
      let newMakerAmount = makerAmount + 1;
      let newMakerAmountLamports = newMakerAmount * LAMPORTS_PER_SOL;

      let makerBeforeEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );

      await program.rpc.initialize(
        new BN(newMakerAmount),
        new BN(takerAmount),
        new BN(vaultBump),
        {
          accounts: {
            maker: maker.publicKey,
            fromMakerAccount: maker.publicKey,
            toMakerAccount: makerTokenB,
            escrowVault: escrowVault,
            escrowState: escrowState.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          },
          signers: [maker, escrowState],
          remainingAccounts: [
            { pubkey: mintB.publicKey, isWritable: false, isSigner: false },
          ],
        }
      );

      let makerDuringEscrow = await provider.connection.getAccountInfo(
        maker.publicKey
      );
      let vaultDuringEscrow = await provider.connection.getAccountInfo(
        escrowVault
      );
      let stateDuringEscrow = await provider.connection.getAccountInfo(
        escrowState.publicKey
      );

      assert.strictEqual(
        makerDuringEscrow!.lamports,
        makerBeforeEscrow!.lamports -
          stateDuringEscrow!.lamports -
          vaultDuringEscrow!.lamports
      );
      assert.strictEqual(vaultDuringEscrow!.lamports, newMakerAmountLamports);

      // Cancel the escrow.
      await program.rpc.cancel(new BN(vaultBump), {
        accounts: {
          maker: maker.publicKey,
          fromMakerAccount: maker.publicKey,
          escrowVault: escrowVault,
          escrowState: escrowState.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        signers: [maker],
      });

      let makerAfterCancel = await provider.connection.getAccountInfo(
        maker.publicKey
      );

      // Check all the funds were sent back there.
      assert.strictEqual(
        makerBeforeEscrow!.lamports,
        makerAfterCancel!.lamports
      );
      assert.strictEqual(
        makerDuringEscrow!.lamports,
        makerBeforeEscrow!.lamports -
          vaultDuringEscrow!.lamports -
          stateDuringEscrow!.lamports
      );
      assert.strictEqual(
        makerAfterCancel!.lamports,
        makerBeforeEscrow!.lamports
      );
      assert.strictEqual(
        makerAfterCancel!.lamports,
        makerDuringEscrow!.lamports +
          vaultDuringEscrow!.lamports +
          stateDuringEscrow!.lamports
      );
    });
  });
});
