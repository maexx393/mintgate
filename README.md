# MintGate

## Terminology
- **User**: any Internet user who may (or may not) have NEAR Account
- **NEAR User**: a User who has NEAR Account
- **Creator (aka Artist)**: a User who has NEAR Account and MintGate account. Creator creates Collectibles. Creator cannot be changed once set for Collectible.
- **Admin**: a NEAR User that operates MintGate NFT contract, or another NEAR Account that takes this role as assigned during build and deployment process of NFT contract.
- **Claimer (aka Holder)**: a NEAR User who mints Tokens for selected Collectible on the NFT contract. Creator and Admin also can act as a Claimer. Claimer becomes an Owner after s_he succesfully minted a Token.
- **Buyer**: a NEAR User who purchases Token from Marketplace. Buyer becomes an Owner after s_he succesfully purchased a Token.
- **Seller**: an Owner who sells Token on the Marketplace from the moment when he approves Marketplace until deal will be settled and he looses ownership over a Token.
- **Owner**: a NEAR User who owns a Token of any Collectible as a result of minting it on NFT contract, buying from Marketplace, or receiving it as a gift from another Owner.
- **Royalty beneficiar**: a NEAR User who receives % from each deal closed on any of the Marketplaces with each Token. There will be exactly 1 Royalty beneficiar. It may be a Creator, but may be not. Royalty beneficiar cannot be changed once set for Collectible. 
- **Collectible**: NFT with information about its Creator, Supply and other Metadata, identified uniquely by GateID provided externally from MintGate platform.
- **GateID**: unique identifier of Collectible that originally generated by MintGate and stored in their master database off-chain.
- **Supply**: maximum amount of Tokens that can be minted for given Collectible. Mimimum supply is 1 ("Pure NFT"). When NFT has Supply > 1 it can be named a semi-fungible Token.
- **Current Supply**: number of remining Tokens available for minting for given Collectible. Current Supply <= Supply, and always decresing towards 0. When CurrentSupply=0 then Tokens for this Collectible can be obtained from Marketplace, or as a result of direct transfer from Owner to NEAR User (as a gift or a deal settled off-chain).  
- **Token**: an asset on NFT Contract that is identified by unique ID and that always belongs to one Collectible and has one Owner. 
