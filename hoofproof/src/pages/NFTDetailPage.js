import React from "react";
import { useParams } from "react-router-dom";
import CowNFTDisplay from "../NFT";

function NFTDetailPage() {
  // Retrieve the ID from the URL parameters using useParams
  const { id } = useParams();

  // Render the NFT details using the CowNFTDisplay component
  return (
    <div>
      <h1>NFT Detail Page for ID: {id}</h1>
      {/* Pass the ID (tokenId) as a prop to CowNFTDisplay */}
      <CowNFTDisplay tokenId={id} />
    </div>
  );
}

export default NFTDetailPage;
