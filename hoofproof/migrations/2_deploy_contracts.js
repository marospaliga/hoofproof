const CowNFT = artifacts.require("CowNFT");

module.exports = function (deployer, network, accounts) {
  // Use the first account from Ganache as the initial owner address
  const initialOwnerAddress = accounts[0];
  deployer.deploy(CowNFT, initialOwnerAddress);
};
