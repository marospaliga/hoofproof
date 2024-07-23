import React, { useState, useEffect } from "react";

function CowNFTDisplay() {
  const [name, setName] = useState("");

  useEffect(() => {
    // Fetch the content of the text file
    fetch("/name.txt")
      .then((response) => response.text())
      .then((text) => {
        setName(text);
      })
      .catch((error) => {
        console.error("Error fetching the text file:", error);
      });
  }, []);

  if (!name) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>This is {name}</h1>
    </div>
  );
}

export default CowNFTDisplay;
