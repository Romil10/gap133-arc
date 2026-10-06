// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title gap133 pay-per-query on Arc
/// @notice Anyone (a person or an AI agent) pays a fixed USDC price to unlock
///         one gap133 query. The off-chain service issues a one-time nonce,
///         the caller pays it here, and the service checks the Paid event
///         before answering. Each nonce can be paid only once.
/// @dev    On Arc, USDC is the native coin with 18 decimals, so payment is
///         plain msg.value. No ERC-20 approval step is needed.
contract Gap133PayPerQuery {
    address public owner;
    /// Address whose signatures appear on every paid response. Agents can
    /// read it here to verify that an answer really came from gap133.
    address public attester;
    /// Price per query in native USDC units (18 decimals).
    uint256 public price;

    mapping(bytes32 => bool) public paid;

    event Paid(bytes32 indexed nonce, address indexed payer, uint256 amount);
    event PriceChanged(uint256 price);
    event AttesterChanged(address attester);
    event OwnerChanged(address owner);
    event Withdrawn(address to, uint256 amount);

    error NotOwner();
    error WrongAmount();
    error NonceUsed();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _attester, uint256 _price) {
        if (_attester == address(0)) revert ZeroAddress();
        owner = msg.sender;
        attester = _attester;
        price = _price;
        emit OwnerChanged(msg.sender);
        emit AttesterChanged(_attester);
        emit PriceChanged(_price);
    }

    /// @notice Pay for one query. Send exactly `price`.
    function pay(bytes32 nonce) external payable {
        if (msg.value != price) revert WrongAmount();
        if (paid[nonce]) revert NonceUsed();
        paid[nonce] = true;
        emit Paid(nonce, msg.sender, msg.value);
    }

    function setPrice(uint256 _price) external onlyOwner {
        price = _price;
        emit PriceChanged(_price);
    }

    function setAttester(address _attester) external onlyOwner {
        if (_attester == address(0)) revert ZeroAddress();
        attester = _attester;
        emit AttesterChanged(_attester);
    }

    function transferOwnership(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnerChanged(_owner);
    }

    /// @notice Send collected USDC to `to`. Arc reverts transfers to
    ///         address(0), so that is rejected up front.
    function withdraw(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    receive() external payable {
        revert WrongAmount();
    }
}
