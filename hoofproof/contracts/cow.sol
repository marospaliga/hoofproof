// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract CowNFT is ERC721, Ownable {
    struct Cow {
        string name;
        uint256 age;
        string gender;
        string color;
        uint256 milkingAmount;
        uint256 udderSize;
        string herdPart;
        bool isAlive;
    }

    mapping(uint256 => Cow) public cows;
    uint256 public nextTokenId;

    // Constructor accepts the initial owner address
    constructor(address initialOwner) ERC721("CowNFT", "COW") {
        transferOwnership(initialOwner);
    }

    function mintCow(
        string memory _name,
        uint256 _age,
        string memory _gender,
        string memory _color,
        uint256 _milkingAmount,
        uint256 _udderSize,
        string memory _herdPart
    ) public onlyOwner {
        uint256 tokenId = nextTokenId;
        nextTokenId += 1;

        _safeMint(msg.sender, tokenId);

        cows[tokenId] = Cow({
            name: _name,
            age: _age,
            gender: _gender,
            color: _color,
            milkingAmount: _milkingAmount,
            udderSize: _udderSize,
            herdPart: _herdPart,
            isAlive: true
        });
    }

    function getCowDetails(uint256 tokenId) public view returns (Cow memory) {
        // Check if the token exists by ensuring that the owner is not the zero address
        require(ownerOf(tokenId) != address(0), "CowNFT: Token does not exist");
        return cows[tokenId];
    }
}
