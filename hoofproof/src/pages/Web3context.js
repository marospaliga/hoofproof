import React, { createContext, useEffect, useState } from "react";
import Web3 from "web3";
import CowNFT from "../build/contracts/CowNFT.json"; // Adjust the path as needed

export const Web3Context = createContext();

const Web3Provider = ({ children }) => {
  const [web3, setWeb3] = useState(null);
  const [contract, setContract] = useState(null);
  const [account, setAccount] = useState("");

  useEffect(() => {
    const initWeb3 = async () => {
      if (window.ethereum) {
        const web3Instance = new Web3(window.ethereum);
        await window.ethereum.enable();
        setWeb3(web3Instance);

        try {
          const networkId = await web3Instance.eth.net.getId();
          console.log("Current network ID:", networkId); // Debugging log
          console.log("CowNFT networks:", CowNFT.networks); // Debugging log
          const networkData = CowNFT.networks[networkId];

          if (networkData) {
            const cowNFTContract = new web3Instance.eth.Contract(
              CowNFT.abi,
              networkData.address
            );
            setContract(cowNFTContract);
            const accounts = await web3Instance.eth.getAccounts();
            setAccount(accounts[0]);
          } else {
            console.error("Smart contract not deployed to detected network.");
          }
        } catch (error) {
          console.error(
            "Error initializing web3 or accessing contract:",
            error
          );
        }
      } else {
        console.error("Please install MetaMask to use this app.");
      }
    };

    initWeb3();
  }, []);

  return (
    <Web3Context.Provider value={{ web3, contract, account }}>
      {children}
    </Web3Context.Provider>
  );
};

export default Web3Provider;
