//! This module implement the MintGate marketplace.
#![deny(warnings)]

use std::{
    convert::TryInto,
    fmt::{Debug, Display},
};

use mg_core::{
    crypto_hash,
    gate::{GateId, ValidGateId},
    nep178::NonFungibleTokenApprovalsReceiver,
    MarketApproveMsg, Payout, TokenId,
};
use near_env::{near_ext, near_log, PanicMessage};
use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    collections::{LookupMap, UnorderedMap, UnorderedSet},
    env, ext_contract,
    json_types::{ValidAccountId, U128, U64},
    near_bindgen,
    serde::{Deserialize, Serialize},
    serde_json, setup_alloc, AccountId, Balance, BorshStorageKey, CryptoHash, Gas, PanicOnDefault,
    Promise, PromiseResult,
};

setup_alloc!();

const GAS_FOR_ROYALTIES: Gas = 120_000_000_000_000;
const NO_DEPOSIT: Balance = 0;

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct MarketContract {
    /// Lists all tokens for sale.
    tokens_for_sale: UnorderedMap<TokenKey, TokenForSale>,
    /// Holds token IDs for sale by `gate_id`.
    tokens_by_nft_id: LookupMap<AccountId, UnorderedSet<TokenId>>,
    /// Holds token IDs for sale by `gate_id`.
    tokens_by_gate_id: LookupMap<GateId, UnorderedSet<TokenKey>>,
    /// Holds token IDs for sale by `owner_id`.
    tokens_by_owner_id: LookupMap<AccountId, UnorderedSet<TokenKey>>,
    /// Holds token IDs for sale by `creator_id`.
    tokens_by_creator_id: LookupMap<AccountId, UnorderedSet<TokenKey>>,
}

/// In marketplace contract, each token must be addressed by `<nft contract id, token id>`.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenKey(AccountId, TokenId);

impl Display for TokenKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{:?}", self.0, self.1)
    }
}

/// Represents a token being sold in this marketplace.
#[derive(BorshDeserialize, BorshSerialize, Serialize)]
#[cfg_attr(not(target_arch = "wasm"), derive(Debug, Deserialize))]
#[serde(crate = "near_sdk::serde")]
pub struct TokenForSale {
    /// The contract account where this token has been minted.
    pub nft_contract_id: AccountId,
    /// The token id for this token.
    pub token_id: TokenId,
    /// Indicates the owner of this token within the `nft_contract_id`.
    pub owner_id: AccountId,
    /// Internal approval id according to NEP-178.
    pub approval_id: U64,
    /// Indicates the minimum price to which this token must being sold.
    pub min_price: U128,
    /// The `gate_id` to which this token belongs to, if any.
    pub gate_id: Option<GateId>,
    /// The `creator_id` of the collectible of this token, if any.
    pub creator_id: Option<AccountId>,
}

#[derive(BorshSerialize, BorshStorageKey)]
enum Keys {
    TokensForSale,
    TokensByNftId,
    TokensByNftIdValue(CryptoHash),
    TokensByGateId,
    TokensByGateIdValue(CryptoHash),
    TokensByOwnerId,
    TokensByOwnerIdValue(CryptoHash),
    TokensByCreatorId,
    TokensByCreatorIdValue(CryptoHash),
}

/// The error variants thrown by *mg-market*.
#[derive(Serialize, PanicMessage)]
#[serde(crate = "near_sdk::serde", tag = "err")]
pub enum Panics {
    /// Thrown when `nft_on_approve` does not find `min_price`.
    #[panic_msg = "Could not find min_price in msg: {}"]
    MsgFormatMinPriceMissing { reason: String },
    /// Thrown when the `token_key` was not found.
    #[panic_msg = "Token Key `{}` was not found"]
    TokenKeyNotFound { token_key: TokenKey },
    /// Thrown when buyer attempts to buy own token.
    #[panic_msg = "Buyer cannot buy own token"]
    BuyOwnTokenNotAllowed,
    /// Thrown when deposit is not enough to buy a token.
    #[panic_msg = "Not enough deposit to cover token minimum price"]
    NotEnoughDepositToBuyToken,
}

/// Methods for the Marketplace contract.
/// Methods belonging to a `trait` are implemented in their own interfaces.
#[near_log(skip_args, only_pub)]
#[near_bindgen]
impl MarketContract {
    /// Initializes the Market contract.
    #[init]
    pub fn init() -> Self {
        Self {
            tokens_for_sale: UnorderedMap::new(Keys::TokensForSale),
            tokens_by_nft_id: LookupMap::new(Keys::TokensByNftId),
            tokens_by_gate_id: LookupMap::new(Keys::TokensByGateId),
            tokens_by_owner_id: LookupMap::new(Keys::TokensByOwnerId),
            tokens_by_creator_id: LookupMap::new(Keys::TokensByCreatorId),
        }
    }

    /// Returns all available tokens for sale.
    /// Use the `nft_on_approve` method to add a token for sale.
    pub fn get_tokens_for_sale(&self) -> Vec<TokenForSale> {
        let mut result = Vec::new();
        for (_, token) in self.tokens_for_sale.iter() {
            result.push(token);
        }
        result
    }

    /// Returns all tokens for sale owned by `owner_id`.
    pub fn get_tokens_by_owner_id(&self, owner_id: ValidAccountId) -> Vec<TokenForSale> {
        get_tokens_by(&self.tokens_for_sale, &self.tokens_by_owner_id, owner_id.as_ref())
    }

    /// Returns all tokens for sale whose collectible's gate ID is `gate_id`.
    pub fn get_tokens_by_gate_id(&self, gate_id: ValidGateId) -> Vec<TokenForSale> {
        get_tokens_by(&self.tokens_for_sale, &self.tokens_by_gate_id, gate_id.as_ref())
    }

    /// Returns all tokens for sale whose collectible's creator ID is `creator_id`.
    pub fn get_tokens_by_creator_id(&self, creator_id: ValidAccountId) -> Vec<TokenForSale> {
        get_tokens_by(&self.tokens_for_sale, &self.tokens_by_creator_id, creator_id.as_ref())
    }

    /// Indicates that `predecessor_account_id` wants to buy the token `nft_contract_id:token_id`.
    ///
    /// The caller must attach at least `min_price` NEARs in order to pay for the given token.
    /// Moreover, the owner cannot buy his/her own tokens.
    ///
    /// When the token is sold,
    /// royalties are paid by this marketplace according to `nft_contract_id::nft_transfer_payout`.
    #[payable]
    pub fn buy_token(&mut self, nft_contract_id: ValidAccountId, token_id: TokenId) {
        let token_key = TokenKey(nft_contract_id.to_string(), token_id);
        if let Some(TokenForSale { owner_id, min_price, gate_id, creator_id, .. }) =
            self.tokens_for_sale.get(&token_key)
        {
            let buyer_id = env::predecessor_account_id();

            if buyer_id == owner_id {
                Panics::BuyOwnTokenNotAllowed.panic();
            }

            let deposit = env::attached_deposit();
            if deposit < min_price.0 {
                Panics::NotEnoughDepositToBuyToken.panic();
            }

            self.remove_token_id(&token_key, &owner_id, &gate_id, &creator_id);

            mg_core::nep171::nft::nft_transfer_payout(
                buyer_id.try_into().unwrap(),
                token_id,
                None,
                None,
                Some(U128(deposit)),
                &nft_contract_id,
                0,
                env::prepaid_gas() / 3,
            )
            .then(self_callback::make_payouts(
                &env::current_account_id(),
                NO_DEPOSIT,
                GAS_FOR_ROYALTIES,
            ));
        } else {
            Panics::TokenKeyNotFound { token_key }.panic();
        }
    }

    fn remove_token_id(
        &mut self,
        token_key: &TokenKey,
        owner_id: &AccountId,
        gate_id: &Option<GateId>,
        creator_id: &Option<AccountId>,
    ) {
        self.tokens_for_sale.remove(&token_key);
        remove_token_id_from(&mut self.tokens_by_nft_id, &token_key, &token_key.0, &token_key.1);
        remove_token_id_from(&mut self.tokens_by_owner_id, &token_key, &owner_id, token_key);
        if let Some(gate_id) = gate_id {
            remove_token_id_from(&mut self.tokens_by_gate_id, &token_key, &gate_id, token_key);
        }
        if let Some(creator_id) = creator_id {
            remove_token_id_from(
                &mut self.tokens_by_creator_id,
                &token_key,
                &creator_id,
                token_key,
            );
        }
    }
}

#[near_ext]
#[ext_contract(self_callback)]
trait SelfCallback {
    fn make_payouts(&mut self);
}

#[near_log(skip_args, only_pub)]
#[near_bindgen]
impl SelfCallback for MarketContract {
    #[private]
    fn make_payouts(&mut self) {
        match env::promise_result(0) {
            PromiseResult::NotReady => unreachable!(),
            PromiseResult::Failed => unreachable!(),
            PromiseResult::Successful(value) => {
                if let Ok(payout) = serde_json::from_slice::<Payout>(&value) {
                    for (receiver_id, amount) in payout {
                        Promise::new(receiver_id).transfer(amount.0);
                    }
                } else {
                    unreachable!();
                }
            }
        }
    }
}

/// This interface defines methods to be called
/// when approval or removal happened in a NFT contract.
#[near_log(skip_args, only_pub)]
#[near_bindgen]
impl NonFungibleTokenApprovalsReceiver for MarketContract {
    /// Callback method to allow this contract to put a `Token` into the marketplace.
    /// The msg must contain the following fields:
    fn nft_on_approve(
        &mut self,
        token_id: TokenId,
        owner_id: ValidAccountId,
        approval_id: U64,
        msg: String,
    ) {
        match serde_json::from_str::<MarketApproveMsg>(&msg) {
            Ok(approve_msg) => {
                let nft_contract_id = env::predecessor_account_id();
                let owner_id = owner_id.to_string();
                self.add_token(&owner_id, &nft_contract_id, token_id, approve_msg, approval_id);
            }
            Err(err) => {
                let reason = err.to_string();
                Panics::MsgFormatMinPriceMissing { reason }.panic();
            }
        }
    }

    /// Callback method to remove this `Token` from the marketplace.
    fn nft_on_revoke(&mut self, token_id: TokenId) {
        let nft_contract_id = env::predecessor_account_id();
        let token_key = TokenKey(nft_contract_id, token_id);

        if let Some(token) = self.tokens_for_sale.get(&token_key) {
            assert_eq!(token.nft_contract_id, token_key.0);
            self.remove_token_id(&token_key, &token.owner_id, &token.gate_id, &token.creator_id);
        } else {
            Panics::TokenKeyNotFound { token_key }.panic();
        }
    }

    /// Callback method to allow this contract to put multiple `Token`s into the marketplace.
    fn batch_on_approve(
        &mut self,
        tokens: Vec<(TokenId, MarketApproveMsg)>,
        owner_id: ValidAccountId,
    ) {
        let nft_contract_id = env::predecessor_account_id();
        let owner_id = owner_id.to_string();
        for (token_id, approve_msg) in tokens {
            self.add_token(&owner_id, &nft_contract_id, token_id, approve_msg, U64(0));
        }
    }
}

impl MarketContract {
    fn add_token(
        &mut self,
        owner_id: &AccountId,
        nft_contract_id: &String,
        token_id: TokenId,
        approve_msg: MarketApproveMsg,
        approval_id: U64,
    ) {
        let token_key = TokenKey(nft_contract_id.clone(), token_id);
        self.tokens_for_sale.insert(
            &token_key,
            &TokenForSale {
                nft_contract_id: nft_contract_id.clone(),
                token_id,
                owner_id: owner_id.clone().into(),
                approval_id,
                min_price: approve_msg.min_price,
                gate_id: approve_msg.gate_id.clone().map(|g| g.to_string()),
                creator_id: approve_msg.creator_id.clone(),
            },
        );

        insert_token_id_to(
            &mut self.tokens_by_nft_id,
            &nft_contract_id,
            &token_id,
            Keys::TokensByNftIdValue,
        );
        insert_token_id_to(
            &mut self.tokens_by_owner_id,
            &owner_id.into(),
            &token_key,
            Keys::TokensByOwnerIdValue,
        );
        if let Some(gate_id) = approve_msg.gate_id {
            insert_token_id_to(
                &mut self.tokens_by_gate_id,
                gate_id.as_ref(),
                &token_key,
                Keys::TokensByGateIdValue,
            );
        }
        if let Some(creator_id) = approve_msg.creator_id {
            insert_token_id_to(
                &mut self.tokens_by_creator_id,
                &creator_id,
                &token_key,
                Keys::TokensByCreatorIdValue,
            );
        }
    }
}

fn insert_token_id_to<T: BorshSerialize + BorshDeserialize, F: FnOnce(CryptoHash) -> Keys>(
    tokens_map: &mut LookupMap<String, UnorderedSet<T>>,
    key: &String,
    token_key: &T,
    f: F,
) {
    let mut tids = tokens_map.get(&key).unwrap_or_else(|| UnorderedSet::new(f(crypto_hash(key))));
    tids.insert(token_key);
    tokens_map.insert(key, &tids);
}

fn get_tokens_by<K: BorshSerialize>(
    ts: &UnorderedMap<TokenKey, TokenForSale>,
    tokens_map: &LookupMap<K, UnorderedSet<TokenKey>>,
    key: &K,
) -> Vec<TokenForSale> {
    match tokens_map.get(&key) {
        None => Vec::new(),
        Some(tids) => {
            tids.iter().map(|token_id| ts.get(&token_id).expect("Token not found")).collect()
        }
    }
}

fn remove_token_id_from<T: BorshSerialize + BorshDeserialize + Clone, K: BorshSerialize>(
    tokens_map: &mut LookupMap<K, UnorderedSet<T>>,
    t: &TokenKey,
    key: &K,
    token_key: &T,
) {
    match tokens_map.get(&key) {
        None => Panics::TokenKeyNotFound { token_key: t.clone() }.panic(),
        Some(mut tids) => {
            if !tids.remove(token_key) {
                Panics::TokenKeyNotFound { token_key: t.clone() }.panic();
            }

            tokens_map.insert(&key, &tids);
        }
    }
}
