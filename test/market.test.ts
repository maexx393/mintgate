import BN from 'bn.js';
import { utils } from 'near-api-js';

import type { Account } from 'near-api-js';

import { addTestCollectible, generateId, getShare, formatNsToMs, logger } from './utils';
import { MINTGATE_FEE } from './initialData';

import type { AccountContract, NftContract, MarketContract, Token, Fraction } from '../src';
import type { MarketApproveMsg, NftApproveMsg, TokenForSale } from '../src/mg-market';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      nftUsers: AccountContract<NftContract>[];
      marketUsers: AccountContract<MarketContract>[];
      nftFeeUser: Account;
    }
  }
}

const {
  format: { parseNearAmount, formatNearAmount },
} = utils;

const GAS = new BN(300000000000000);

describe('Market contract', () => {
  const [alice, bob] = global.nftUsers;
  const [merchant, merchant2] = global.marketUsers;

  const mintgate = global.nftFeeUser;

  beforeEach(() => {
    logger.title(`${expect.getState().currentTestName}`);
  });

  describe('get_tokens_for_sale', () => {
    it('returns a list of tokens for sale', async () => {
      const numberOfTokensToAdd = 3;
      const message: NftApproveMsg = { min_price: '5' };
      const newTokensIds: string[] = [];

      const gateId = await generateId();
      await addTestCollectible(bob.contract, { gate_id: gateId });

      for (let i = 0; i < numberOfTokensToAdd; i += 1) {
        newTokensIds.push(await bob.contract.claim_token({ gate_id: gateId }));
      }

      await Promise.all(
        newTokensIds.map((tokenId) =>
          bob.contract.nft_approve({
            token_id: tokenId,
            account_id: merchant.contract.contractId,
            msg: JSON.stringify(message),
          })
        )
      );

      const tokensForSale = await merchant.contract.get_tokens_for_sale();

      expect(tokensForSale.map(({ token_id }) => token_id)).toEqual(expect.arrayContaining(newTokensIds));
    });
  });

  describe('nft_on_approve', () => {
    let gateId: string;
    let tokenId: string;

    const message: MarketApproveMsg = {
      min_price: '5',
      gate_id: '',
      creator_id: '',
    };

    beforeAll(async () => {
      gateId = await generateId();

      message.creator_id = bob.contract.contractId;
      message.gate_id = gateId;

      await addTestCollectible(bob.contract, { gate_id: gateId });

      tokenId = await alice.contract.claim_token({ gate_id: gateId });

      await merchant.contract.nft_on_approve({
        token_id: tokenId,
        owner_id: alice.accountId,
        approval_id: '5',
        msg: JSON.stringify(message),
      });
    });

    test('that market lists the token as for sale', async () => {
      const tokensForSale = await merchant.contract.get_tokens_for_sale();

      expect(tokensForSale).toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });
  });

  describe('buy_token', () => {
    const priceHrNear = '5';
    const priceInternalNear = parseNearAmount(priceHrNear);

    const royalty: Fraction = {
      num: 3,
      den: 10,
    };

    const mintgateShare = getShare(+priceHrNear, MINTGATE_FEE);
    const creatorShare = getShare(+priceHrNear, royalty);
    const sellerShare = +priceHrNear - mintgateShare - creatorShare;

    const message: NftApproveMsg = { min_price: priceInternalNear! };

    let gateId: string;
    let tokenId: string;

    let mintgateBalanceBefore: string;
    let mintgateBalanceAfter: string;
    let creatorBalanceBefore: string;
    let creatorBalanceAfter: string;
    let sellerBalanceBefore: string;
    let sellerBalanceAfter: string;
    let buyerBalanceBefore: string;
    let buyerBalanceAfter: string;

    let token: Token;

    beforeAll(async () => {
      gateId = await generateId();
      await addTestCollectible(bob.contract, {
        gate_id: gateId,
        royalty,
      });

      tokenId = await alice.contract.claim_token({ gate_id: gateId });
      await alice.contract.nft_approve({
        token_id: tokenId,
        account_id: merchant.contract.contractId,
        msg: JSON.stringify(message),
      });

      buyerBalanceBefore = (await merchant2.account.getAccountBalance()).total;
      [
        { total: buyerBalanceBefore },
        { total: mintgateBalanceBefore },
        { total: creatorBalanceBefore },
        { total: sellerBalanceBefore },
      ] = await Promise.all([
        merchant2.account.getAccountBalance(),
        mintgate.getAccountBalance(),
        bob.account.getAccountBalance(),
        alice.account.getAccountBalance(),
      ]);

      await merchant2.contract.buy_token({ token_id: tokenId }, GAS, new BN(priceInternalNear!));

      [
        { total: buyerBalanceAfter },
        { total: mintgateBalanceAfter },
        { total: creatorBalanceAfter },
        { total: sellerBalanceAfter },
      ] = await Promise.all([
        merchant2.account.getAccountBalance(),
        mintgate.getAccountBalance(),
        bob.account.getAccountBalance(),
        alice.account.getAccountBalance(),
      ]);

      [token] = (await alice.contract.get_tokens_by_owner({ owner_id: merchant2.accountId })).filter(
        ({ token_id }) => token_id === tokenId
      );
    });

    it("should transfer mintgate's fee to its' wallet", async () => {
      const mintgateBalanceBeforeHr = formatNearAmount(mintgateBalanceBefore);
      const mintgateBalanceAfterHr = formatNearAmount(mintgateBalanceAfter);

      logger.data('mintgateBalanceBeforeHr', mintgateBalanceBeforeHr);
      logger.data('mintgateBalanceAfterHr', mintgateBalanceAfterHr);
      logger.data('mintgateShare', mintgateShare);
      logger.data('mintgateShareActual', +mintgateBalanceAfterHr - +mintgateBalanceBeforeHr);

      expect(+mintgateBalanceBeforeHr + mintgateShare).toBeCloseTo(+mintgateBalanceAfterHr, 5);
    });

    it("should transfer royalty to the creator's wallet", async () => {
      const creatorBalanceBeforeHr = formatNearAmount(creatorBalanceBefore);
      const creatorBalanceAfterHr = formatNearAmount(creatorBalanceAfter);

      logger.data('creatorBalanceBeforeHr', creatorBalanceBeforeHr);
      logger.data('creatorBalanceAfterHr', creatorBalanceAfterHr);
      logger.data('creatorShare', creatorShare);
      logger.data('creatorShareActual', +creatorBalanceAfterHr - +creatorBalanceBeforeHr);

      expect(+creatorBalanceBeforeHr + creatorShare).toBeCloseTo(+creatorBalanceAfterHr, 5);
    });

    it("should transfer the remaining amount to the seller's wallet", async () => {
      const sellerBalanceBeforeHr = formatNearAmount(sellerBalanceBefore);
      const sellerBalanceAfterHr = formatNearAmount(sellerBalanceAfter);

      logger.data('sellerBalanceBeforeHr', sellerBalanceBeforeHr);
      logger.data('sellerBalanceAfterHr', sellerBalanceAfterHr);
      logger.data('sellerShare', sellerShare);
      logger.data('sellerShareActual', +sellerBalanceAfterHr - +sellerBalanceBeforeHr);

      expect(+sellerBalanceBeforeHr + sellerShare).toBeCloseTo(+sellerBalanceAfterHr, 2);
    });

    it("should deduct token's price from buyer's wallet", async () => {
      const buyerBalanceBeforeHr = formatNearAmount(buyerBalanceBefore);
      const buyerBalanceAfterHr = formatNearAmount(buyerBalanceAfter);

      logger.data('buyerBalanceBeforeHr', buyerBalanceBeforeHr);
      logger.data('buyerBalanceAfterHr', buyerBalanceAfterHr);
      logger.data('priceHrNear', priceHrNear);
      logger.data('buyerShareActual', +buyerBalanceAfterHr - +buyerBalanceBeforeHr);

      expect(+buyerBalanceBeforeHr - +priceHrNear).toBeCloseTo(+buyerBalanceAfterHr, 1);
    });

    describe('token transfer', () => {
      it("should associate token with it's new owner", () => {
        expect(token).not.toBeUndefined();
      });

      it("should disassociate token from it's previous owner", async () => {
        const [soldToken] = (await alice.contract.get_tokens_by_owner({ owner_id: alice.accountId })).filter(
          ({ token_id }) => token_id === tokenId
        );

        expect(soldToken).toBeUndefined();
      });

      it("should set token's new owner", async () => {
        expect(token!.owner_id).toBe(merchant2.accountId);
      });

      it("should update token's modified_at property", async () => {
        expect(formatNsToMs(token!.modified_at)).toBeGreaterThan(formatNsToMs(token!.created_at));
      });

      it("should set token's sender", () => {
        expect(token!.sender_id).toBe(merchant2.contract.contractId);
      });
    });

    describe('delist token from the market', () => {
      let tokensForSale: TokenForSale[];
      let tokensByGateId: TokenForSale[];
      let tokensByPreviousOwnerId: TokenForSale[];
      let tokensByOwnerId: TokenForSale[];
      let tokensByCreatorId: TokenForSale[];

      beforeAll(async () => {
        [
          tokensForSale,
          tokensByGateId,
          tokensByPreviousOwnerId,
          tokensByOwnerId,
          tokensByCreatorId,
        ] = await Promise.all([
          merchant.contract.get_tokens_for_sale(),
          merchant.contract.get_tokens_by_gate_id({ gate_id: gateId }),
          merchant.contract.get_tokens_by_owner_id({ owner_id: alice.accountId }),
          merchant.contract.get_tokens_by_owner_id({ owner_id: merchant2.accountId }),
          merchant.contract.get_tokens_by_creator_id({ creator_id: bob.accountId }),
        ]);
      });

      test('all tokens', async () => {
        expect(tokensForSale).not.toContainEqual(expect.objectContaining({ token_id: token.token_id }));
      });

      test('by gate id', async () => {
        expect(tokensByGateId).not.toContainEqual(expect.objectContaining({ token_id: token.token_id }));
      });

      test('by previous owner id', async () => {
        expect(tokensByPreviousOwnerId).not.toContainEqual(expect.objectContaining({ token_id: token.token_id }));
      });

      test('by owner id', async () => {
        expect(tokensByOwnerId).not.toContainEqual(expect.objectContaining({ token_id: token.token_id }));
      });

      test('by creator id', async () => {
        expect(tokensByCreatorId).not.toContainEqual(expect.objectContaining({ token_id: token.token_id }));
      });
    });

    describe('errors', () => {
      it('should throw when the buyer and the seller are the same person', async () => {
        const tokenId2 = await alice.contract.claim_token({ gate_id: gateId });
        const approveMessage: MarketApproveMsg = {
          min_price: '5',
          gate_id: '',
          creator_id: '',
        };

        await alice.contract.nft_transfer({
          receiver_id: merchant2.accountId,
          token_id: tokenId2,
          enforce_approval_id: null,
          memo: null,
        });

        await merchant.contract.nft_on_approve({
          token_id: tokenId2,
          owner_id: merchant2.accountId,
          approval_id: '10',
          msg: JSON.stringify(approveMessage),
        });

        await expect(
          merchant2.contract.buy_token({ token_id: tokenId2 }, GAS, new BN(priceInternalNear!))
        ).rejects.toThrow(
          expect.objectContaining({
            type: 'GuestPanic',
            panic_msg: '{"err":"BuyOwnTokenNotAllowed","msg":"Buyer cannot buy own token"}',
          })
        );
      });

      it('should throw on buying not approved token', async () => {
        const tokenId3 = await alice.contract.claim_token({ gate_id: gateId });

        await expect(
          merchant2.contract.buy_token({ token_id: tokenId3 }, GAS, new BN(priceInternalNear!))
        ).rejects.toThrow(
          expect.objectContaining({
            type: 'GuestPanic',
            panic_msg: `{"err":"TokenIdNotFound","token_id":"${tokenId3}","msg":"Token ID \`U64(${tokenId3})\` was not found"}`,
          })
        );
      });

      it('should throw when not enough deposit provided', async () => {
        const tokenId4 = await alice.contract.claim_token({ gate_id: gateId });
        const notEnoughDeposit = new BN(priceInternalNear!).sub(new BN(1));

        await alice.contract.nft_approve({
          token_id: tokenId4,
          account_id: merchant.contract.contractId,
          msg: JSON.stringify(message),
        });

        await expect(merchant2.contract.buy_token({ token_id: tokenId4 }, GAS, notEnoughDeposit)).rejects.toThrow(
          expect.objectContaining({
            type: 'GuestPanic',
            panic_msg: '{"err":"NotEnoughDepositToBuyToken","msg":"Not enough deposit to cover token minimum price"}',
          })
        );
      });
    });
  });

  describe.each(['gate_id', 'owner_id', 'creator_id'])('get_tokens_by_%s', (by) => {
    const numberOfTokensToCreate = 3;

    let bys: { [key: string]: string; gate_id: string; owner_id: string; creator_id: string };
    let gateId: string;
    const newTokensIds: string[] = [];

    beforeAll(async () => {
      gateId = await generateId();

      await addTestCollectible(alice.contract, { gate_id: gateId });

      for (let i = 0; i < numberOfTokensToCreate; i += 1) {
        newTokensIds.push(await bob.contract.claim_token({ gate_id: gateId }));
      }

      await Promise.all(
        newTokensIds.map((tokenId) =>
          bob.contract.nft_approve({
            token_id: tokenId,
            account_id: merchant.contract.contractId,
            msg: JSON.stringify({ min_price: '5' }),
          })
        )
      );

      bys = {
        gate_id: gateId,
        owner_id: bob.accountId,
        creator_id: alice.accountId,
      };
    });

    it(`should return a list of tokens for sale by ${by}`, async () => {
      const tokensForSale = <(TokenForSale & { [key: string]: string })[]>await merchant.contract.get_tokens_for_sale();
      const tokensForSaleBy = await merchant.contract[`get_tokens_by_${by}`]({ [by]: bys[by] });

      expect(tokensForSale.filter((token) => token[by] === bys[by])).toEqual(tokensForSaleBy);
    });

    it('should return an empty array if no tokens found', async () => {
      const nonExistentId = 'non_existent_id';

      expect(await merchant.contract[`get_tokens_by_${by}`]({ [by]: nonExistentId })).toEqual([]);
    });
  });

  describe('nft_on_revoke', () => {
    let tokensForSale: TokenForSale[];
    let tokensByGateId: TokenForSale[];
    let tokensByPreviousOwnerId: TokenForSale[];
    let tokensByOwnerId: TokenForSale[];
    let tokensByCreatorId: TokenForSale[];

    let gateId: string;
    let tokenId: string;

    beforeAll(async () => {
      gateId = await generateId();
      await addTestCollectible(bob.contract, {
        gate_id: gateId,
      });

      tokenId = await alice.contract.claim_token({ gate_id: gateId });
      await alice.contract.nft_approve({
        token_id: tokenId,
        account_id: merchant.contract.contractId,
        msg: JSON.stringify({ min_price: '5' }),
      });

      await alice.contractAccount.functionCall(merchant.contract.contractId, 'nft_on_revoke', { token_id: tokenId });

      [tokensForSale, tokensByGateId, tokensByPreviousOwnerId, tokensByOwnerId, tokensByCreatorId] = await Promise.all([
        merchant.contract.get_tokens_for_sale(),
        merchant.contract.get_tokens_by_gate_id({ gate_id: gateId }),
        merchant.contract.get_tokens_by_owner_id({ owner_id: alice.accountId }),
        merchant.contract.get_tokens_by_owner_id({ owner_id: merchant2.accountId }),
        merchant.contract.get_tokens_by_creator_id({ creator_id: bob.accountId }),
      ]);
    });

    test('all tokens', async () => {
      expect(tokensForSale).not.toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });

    test('by gate id', async () => {
      expect(tokensByGateId).not.toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });

    test('by previous owner id', async () => {
      expect(tokensByPreviousOwnerId).not.toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });

    test('by owner id', async () => {
      expect(tokensByOwnerId).not.toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });

    test('by creator id', async () => {
      expect(tokensByCreatorId).not.toContainEqual(expect.objectContaining({ token_id: tokenId }));
    });

    describe('errors', () => {
      it('should throw when revoking not approved token', async () => {
        const tokenId2 = await alice.contract.claim_token({ gate_id: gateId });

        await expect(
          alice.contractAccount.functionCall(merchant.contract.contractId, 'nft_on_revoke', { token_id: tokenId2 })
        ).rejects.toThrow(
          expect.objectContaining({
            type: 'GuestPanic',
            panic_msg: `{"err":"TokenIdNotFound","token_id":"${tokenId2}","msg":"Token ID \`U64(${tokenId2})\` was not found"}`,
          })
        );
      });

      it('should throw when trying to call from not nft approved contract', async () => {
        const tokenId3 = await alice.contract.claim_token({ gate_id: gateId });

        await alice.contract.nft_approve({
          token_id: tokenId3,
          account_id: merchant.contract.contractId,
          msg: JSON.stringify({ min_price: '5' }),
        });

        await expect(
          bob.account.functionCall(merchant.contract.contractId, 'nft_on_revoke', { token_id: tokenId3 })
        ).rejects.toThrow(
          expect.objectContaining({
            type: 'GuestPanic',
            panic_msg: '{"err":"RevokeNotAllowed","msg":"Only nft approved contract can delist a token"}',
          })
        );
      });
    });
  });
});
