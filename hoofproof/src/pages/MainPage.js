import React from "react";
import { Link } from "react-router-dom";
import { Grid, GridItem, Box, Heading, Image } from "@chakra-ui/react";

function MainPage() {
  // Example NFT data (in a real application, this data might come from an API)
  const nftData = [
    {
      id: "1",
      imageUrl: "/brown-Guernsey-cow.webp",
    },
    {
      id: "2",
      imageUrl: "/cowvedic.jpeg",
    },
    {
      id: "3",
      imageUrl: "/fancyAiCow.jpeg",
    },
    {
      id: "4",
      imageUrl: "/cow.jpeg",
    },
    {
      id: "5",
      imageUrl: "/439181603_322795450822831_9217858880404203238_n.jpeg",
    },
    // Add more NFT data...
  ];

  return (
    <Box p={4}>
      <Heading as="h1" mb={4}>
        Main Page
      </Heading>
      <Grid templateColumns="repeat(auto-fill, minmax(200px, 1fr))" gap={4}>
        {nftData.map((nft) => (
          <GridItem boxSize={"sm"} key={nft.id}>
            <Link to={`/nft/${nft.id}`}>
              <Image src={nft.imageUrl} alt={`NFT ${nft.id}`} boxSize="200px" />
            </Link>
          </GridItem>
        ))}
      </Grid>
    </Box>
  );
}

export default MainPage;
