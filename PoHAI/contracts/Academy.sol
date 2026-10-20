// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Stasis} from "./Stasis.sol";

/// @title Academy — learn the craft, earn your first standing
///
/// The zero-start on-ramp: every account begins with 0 Stasis and works its
/// way into the rating democracy. The cow-care curriculum is the first door —
/// read the lessons, pass the quizzes, and each finished lesson pays a modest
/// one-time Stasis award large enough to cover a Labor-claim bond and buy a
/// first vote.
///
/// Lesson text lives in the app bundle; the *hash* of each lesson is pinned
/// here by the owner, so the curriculum is auditable and versioned on-chain.
/// Quizzes are graded off-chain by the trusted grader (the server), which
/// signs a completion record (EIP-712). The contract verifies the signature —
/// a forged completion is impossible without the grader key.
///
/// Certification lessons (the advanced ones) award the `certified` badge.
/// The badge is reputation, never a gate: no action in the system is blocked
/// for lacking it.
contract Academy is Ownable, EIP712 {
    using ECDSA for bytes32;

    struct Lesson {
        bytes32 contentHash; // keccak256 of the lesson file, pinned by owner
        uint256 reward; // one-time Stasis award on pass (gain-capped by Stasis)
        bool exists;
        bool cert; // advanced lesson — counts toward the certified badge
    }

    Stasis public immutable stasis;

    /// @notice The address allowed to sign quiz completions (the server).
    address public grader;

    mapping(uint8 => Lesson) public lessons;
    uint8 public lessonCount;
    uint8 public certLessonCount;

    mapping(address => mapping(uint8 => bool)) public completed;
    mapping(address => uint8) public certsEarned;

    event LessonSet(uint8 indexed lessonId, bytes32 contentHash, uint256 reward, bool cert);
    event GraderSet(address indexed grader);
    event LessonCompleted(address indexed account, uint8 indexed lessonId, uint256 reward, uint256 awarded);

    error UnknownLesson();
    error AlreadyCompleted();
    error NotGrader();
    error ZeroAddress();

    /// @dev EIP-712 typehash of the completion record.
    bytes32 private constant COMPLETED_TYPEHASH =
        keccak256("Completed(uint8 lessonId,address account)");

    constructor(Stasis _stasis) Ownable(msg.sender) EIP712("HoofProofAcademy", "1") {
        stasis = _stasis;
    }

    // ------------------------------------------------------- curriculum

    /// @notice Add or update a lesson. `contentHash` pins the lesson file
    ///         (keccak256 of the markdown); `reward` is paid once on pass.
    ///         The curriculum's shape may change; `isCertified` compares
    ///         against the *current* cert lesson count.
    function setLesson(uint8 lessonId, bytes32 contentHash, uint256 reward, bool cert) external onlyOwner {
        Lesson storage l = lessons[lessonId];
        if (!l.exists) {
            l.exists = true;
            lessonCount += 1;
            if (cert) certLessonCount += 1;
        } else if (l.cert != cert) {
            if (cert) certLessonCount += 1;
            else certLessonCount -= 1;
        }
        l.contentHash = contentHash;
        l.reward = reward;
        l.cert = cert;
        emit LessonSet(lessonId, contentHash, reward, cert);
    }

    function setGrader(address _grader) external onlyOwner {
        if (_grader == address(0)) revert ZeroAddress();
        grader = _grader;
        emit GraderSet(_grader);
    }

    // ------------------------------------------------------- completion

    /// @notice Submit a grader-signed quiz completion. The caller is the
    ///         account credited; the signature binds (account, lessonId) so a
    ///         completion cannot be replayed for anyone else or any lesson.
    function complete(uint8 lessonId, bytes calldata signature) external {
        Lesson storage l = lessons[lessonId];
        if (!l.exists) revert UnknownLesson();
        if (completed[msg.sender][lessonId]) revert AlreadyCompleted();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(COMPLETED_TYPEHASH, lessonId, msg.sender)));
        if (ECDSA.recover(digest, signature) != grader) revert NotGrader();

        completed[msg.sender][lessonId] = true;
        uint256 awarded = 0;
        if (l.reward > 0) awarded = stasis.award(msg.sender, l.reward, "course");
        if (l.cert) certsEarned[msg.sender] += 1;

        emit LessonCompleted(msg.sender, lessonId, l.reward, awarded);
    }

    // ------------------------------------------------------- views

    function isCertified(address account) external view returns (bool) {
        return certLessonCount > 0 && certsEarned[account] >= certLessonCount;
    }

    /// @notice Everything the client needs to render one lesson row.
    function lessonInfo(uint8 lessonId)
        external
        view
        returns (bytes32 contentHash, uint256 reward, bool exists, bool cert)
    {
        Lesson storage l = lessons[lessonId];
        return (l.contentHash, l.reward, l.exists, l.cert);
    }
}
