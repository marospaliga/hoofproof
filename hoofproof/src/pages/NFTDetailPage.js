// src/pages/NFTDetailPage.js
import React from "react";
import { useParams } from "react-router-dom";
import CowNFTDisplay from "./CowNFTDisplay.js"; // Make sure the path is correct

function NFTDetailPage() {
  const { id } = useParams();

  return (
    <div>
      <h1>NFT Detail Page for ID: {id}</h1>
      {/* Pass the ID as a prop to CowNFTDisplay */}
      <CowNFTDisplay tokenId={id} />
    </div>
  );
}

export default NFTDetailPage;
