// src/NFT/CowNFTDisplay.js
import React, { useContext, useEffect, useState } from "react";
import { Web3Context } from "./Web3context.js"; // Import the context
import { Box, Image, Text, Heading } from "@chakra-ui/react";

const CowNFTDisplay = ({ tokenId }) => {
  const { contract } = useContext(Web3Context);
  const [nftDetails, setNftDetails] = useState(null);

  useEffect(() => {
    const fetchNFTDetails = async () => {
      if (contract) {
        try {
          const details = await contract.methods.getCowDetails(tokenId).call();
          setNftDetails(details);
        } catch (error) {
          console.error("Error fetching NFT details:", error);
        }
      }
    };

    fetchNFTDetails();
  }, [contract, tokenId]);

  if (!nftDetails) {
    return <Text>Loading...</Text>;
  }

  return (
    <Box p={4}>
      <Heading as="h2" mb={4}>
        Cow NFT Details
      </Heading>
      <Image
        src={nftDetails.imageUrl || "/default-image.jpeg"}
        alt={`Cow ${tokenId}`}
        boxSize="200px"
      />
      <Text>Name: {nftDetails.name}</Text>
      <Text>Age: {nftDetails.age}</Text>
      <Text>Gender: {nftDetails.gender}</Text>
      <Text>Color: {nftDetails.color}</Text>
      <Text>Milking Amount: {nftDetails.milkingAmount}</Text>
      <Text>Udder Size: {nftDetails.udderSize}</Text>
      <Text>Herd Part: {nftDetails.herdPart}</Text>
      <Text>Is Alive: {nftDetails.isAlive ? "Yes" : "No"}</Text>
    </Box>
  );
};

export default CowNFTDisplay;
