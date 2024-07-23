import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import MainPage from "./pages/MainPage";
import NFTDetailPage from "./pages/NFTDetailPage";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/nft/:id" element={<NFTDetailPage />} />
      </Routes>
    </Router>
  );
}

export default App;
