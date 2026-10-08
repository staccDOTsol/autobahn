// Bonding curves observed by FTL are launch markets, not user-owned LP positions.
// Their migration creates an AMM pool; LP actions belong to that destination.
export const curveCapabilities = [
  {id:'meteora-dbc',programIds:['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],capabilities:[],parameters:{},marketType:'bonding-curve',protocolOperations:['launch','swap','migrate'],migrationVenues:['meteora-damm','meteora-damm-v2'],reason:'DBC liquidity comes from its configured launch curve. Arbitrary LP deposits and withdrawals are not protocol operations. Pool creation uses the DBC launch flow, including mint metadata and curve configuration.'},
  {id:'pumpfun',programIds:['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],capabilities:[],parameters:{},marketType:'bonding-curve',protocolOperations:['launch','swap','migrate'],migrationVenues:['pumpswap'],reason:'Pump bonding curves use token creation and trading, then migrate into PumpSwap. LP deposits and withdrawals apply to the migrated PumpSwap pool.'},
  {id:'raydium-launchlab',programIds:['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'],capabilities:[],parameters:{},marketType:'bonding-curve',protocolOperations:['launch','swap','migrate'],migrationVenues:['raydium-amm','raydium-cpmm'],reason:'LaunchLab curves initialize a token launch and migrate to an AMM. They do not expose arbitrary depositor LP add/remove operations.'},
];
