/*
  TODO: move to integration test REPO
  npx truffle --network ganacheUnitTest exec test/load/gas_utilization.js save
    => Computes the gas used by various contract functions and writes it to a logs/gas-utilization.yaml

  npx truffle --network ganacheUnitTest exec test/load/gas_utilization.js verify
    => Verifies if the gas amounts in logs/gas-utilization.yaml is consistent with the computed values
*/
const UFragments = artifacts.require('UFragments.sol');
const UFragmentsPolicy = artifacts.require('UFragmentsPolicy.sol');
const MockUFragments = artifacts.require('MockUFragments.sol');
const MockMarketOracle = artifacts.require('MockMarketOracle.sol');

const yaml = require('js-yaml');
const fs = require('fs');
const BigNumber = web3.BigNumber;
const rp = require('request-promise');
const encodeCall = require('zos-lib/lib/helpers/encodeCall').default;

const APP_ROOT_PATH = require('app-root-path');
const _require = APP_ROOT_PATH.require;
const generateYaml = _require('/util/yaml_generator');
const BlockchainCaller = _require('/util/blockchain_caller');
const chain = new BlockchainCaller(web3);

const network = artifacts.options._values.network;
const truffleConfig = _require('/truffle.js');
const config = truffleConfig.networks[network];

let gasPriceEth, ethUSDRate;
const computedGasUtilization = {};

async function loadTransactionMetrics (msg, txR) {
  const tx = await chain.getTransactionMetrics((txR.tx || txR));
  console.log('\t=Gas Used:', tx.gasUsed);
  console.log('\t=ETH value:', gasPriceEth.mul(tx.gasUsed).toString());
  console.log('\t=USD value:', gasPriceEth.mul(tx.gasUsed).mul(ethUSDRate).toString());
  console.log('\t=Bytecode Size (bytes):', tx.byteCodeSize);
  computedGasUtilization[msg] = tx.gasUsed;
}

function cleanRoomTx (msg, fn) {
  console.log('-', msg);
  return chain.cleanRoom(async () => {
    loadTransactionMetrics(msg, await fn());
  });
}

async function ethConversionRate () {
  try {
    const resp = await rp('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
    const rate = JSON.parse(resp).USD;
    return parseFloat(rate);
  } catch (e) {
    console.warn('Failed to fetch ETH/USD converstion rate, using 1ETH=700$');
    return 700;
  }
}

async function computeGasUtilization () {
  ethUSDRate = await ethConversionRate();
  gasPriceEth = new BigNumber(config.gasPrice).div(10 ** 18);

  const accounts = await chain.getUserAccounts();
  const deployer = accounts[0];
  const user = accounts[1];

  const mockUFragments = await MockUFragments.new();
  const mockMarketOracle = await MockMarketOracle.new();
  const uFragments = await UFragments.new();
  const uFragmentsPolicy = await UFragmentsPolicy.new();
  await uFragmentsPolicy.sendTransaction({
    data: encodeCall('initialize', ['address', 'address', 'address'], [deployer, mockUFragments.address, mockMarketOracle.address]),
    from: deployer
  });
  await uFragments.sendTransaction({
    data: encodeCall('initialize', ['address'], [deployer]),
    from: deployer
  });

  const callerConfig = {
    from: deployer,
    gas: config.gas
  };

  console.log('GasPrice (WEI):', config.gasPrice);
  console.log('USD to ETH:', ethUSDRate);
  console.log('Block gas limit:', await chain.getBlockGasLimit());
  console.log('-----------------------------------------------------');

  console.log('FRAGMENTS ERC20 CONTRACT FUNCTIONS');
  console.log('-----------------------------------------------------');

  await cleanRoomTx('UFragments:transfer(user, 10)', async () => {
    return uFragments.transfer(user, 10, callerConfig);
  });

  console.log('-----------------------------------------------------');

  await cleanRoomTx('UFragments: approve and transferFrom(user, 10)', async () => {
    await uFragments.approve(user, 10, callerConfig);
    return uFragments.transferFrom(deployer, user, 10, {
      from: user,
      gas: callerConfig.gas
    });
  });
  console.log('-----------------------------------------------------');

  await cleanRoomTx('UFragments:rebase(1, +100)', async () => {
    await uFragments.setMonetaryPolicy(deployer, callerConfig);
    return uFragments.rebase(1, 100, callerConfig);
  });

  await cleanRoomTx('UFragmentsPolicy:rebase() [WITH STUB]', async () => {
    await mockMarketOracle.storeRate(1.3e18, callerConfig);
    await mockMarketOracle.storeVolume(100, callerConfig);
    await mockUFragments.storeSupply(1010, callerConfig);
    return uFragmentsPolicy.rebase(callerConfig);
  });
  console.log('**************************************************************');
}

function verifyGasUtilization (gasUtilization, _gasUtilization) {
  let k;
  for (k in gasUtilization) {
    if (Object.prototype.hasOwnProperty.call(gasUtilization, k)) {
      const utilization = new BigNumber(gasUtilization[k]);
      const _utilization = new BigNumber(_gasUtilization[k]);
      if (!utilization.minus(_utilization).eq(0)) {
        throw new Error(`Gas utilization changed significantly for fn ${k}`);
      }
    }
  }
}

/*
  Computes the estimated gas for all public/external contract functions
*/
module.exports = async function (callback) {
  const option = (process.argv[process.argv.length - 1] || 'save');
  const opPath = `${APP_ROOT_PATH}/test/logs/gas-utilization.yaml`;
  console.log('**************************************************************');
  await computeGasUtilization();
  if (option === 'save') {
    await generateYaml(computedGasUtilization, opPath);
    console.log('Saved gas utilization information to', opPath);
  } else if (option === 'verify') {
    const _gasUtilization = yaml.safeLoad(fs.readFileSync(opPath));
    verifyGasUtilization(computedGasUtilization, _gasUtilization);
    console.log('NO SIGNIFICANT CHANGE in gas utilization');
  }
  console.log('**************************************************************');
  process.exit(0);
};
