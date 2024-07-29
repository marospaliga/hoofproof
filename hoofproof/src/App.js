import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import MainPage from "./pages/MainPage";
import NFTDetailPage from "./pages/NFTDetailPage";
import Web3Provider from "./pages/Web3context.js"; // Import Web3Provider

function App() {
  return (
    <Web3Provider>
      <Router>
        <Routes>
          <Route path="/" element={<MainPage />} />
          <Route path="/nft/:id" element={<NFTDetailPage />} />
        </Routes>
      </Router>
    </Web3Provider>
  );
}

export default App;
