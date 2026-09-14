// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal 6-decimals ERC-20 with a public mint, used to settle WAITSI's real
// x402 sponsor top-ups on a local Anvil chain (no external funding needed).
contract UnitToken {
  string public name = "USDX Test";
  string public symbol = "USDX";
  uint8 public decimals = 6;
  uint256 public totalSupply;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  function mint(address to, uint256 amt) external {
    totalSupply += amt;
    balanceOf[to] += amt;
    emit Transfer(address(0), to, amt);
  }

  function transfer(address to, uint256 amt) external returns (bool) {
    _transfer(msg.sender, to, amt);
    return true;
  }

  function approve(address spender, uint256 amt) external returns (bool) {
    allowance[msg.sender][spender] = amt;
    emit Approval(msg.sender, spender, amt);
    return true;
  }

  function transferFrom(address from, address to, uint256 amt) external returns (bool) {
    require(allowance[from][msg.sender] >= amt, "allowance");
    allowance[from][msg.sender] -= amt;
    _transfer(from, to, amt);
    return true;
  }

  function _transfer(address from, address to, uint256 amt) internal {
    balanceOf[from] -= amt;
    balanceOf[to] += amt;
    emit Transfer(from, to, amt);
  }
}