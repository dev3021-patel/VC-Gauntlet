"""Player accounts: a name plus a 4-digit PIN, with bearer tokens for return visits.

The store keeps everything in memory and, when ``PLAYER_STORE_PATH`` is set,
mirrors it to a JSON file after every change so a restart does not lose
accounts or sessions. Each process has its own store; see BACKEND.md for the
multi-replica caveat.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field

NAME_MAX_LENGTH = 24
PIN_PATTERN = re.compile(r"^\d{4}$")
# Every built-in avatar is free: selectable at registration and by every account.
# The launch set is followed by the historical figures and the former shop set;
# the frontend AVATAR_IDS mirrors this order.
AVATARS = (
    "ember", "tide", "moss", "dune", "frost", "ash",
    "dog", "clown", "shark", "toilet", "hot-dog", "cowboy-hat",
    "cleopatra", "julius-caesar", "genghis-khan", "joan-of-arc", "leonardo-da-vinci", "william-shakespeare",
    "galileo-galilei", "isaac-newton", "napoleon-bonaparte", "ada-lovelace", "abraham-lincoln", "harriet-tubman",
    "robot", "dragon", "crown", "ghost", "cat", "alien", "wizard", "skull",
)
ALL_AVATARS = AVATARS
# Account-private uploaded image. Registration sends CUSTOM_AVATAR_CHOICE with the
# image; the stored avatar is then a per-upload ID naming its owner, so equipping
# and rendering never need a separate lookup. A replacement mints a new ID.
CUSTOM_AVATAR_CHOICE = "custom"
CUSTOM_AVATAR_PATTERN = re.compile(r"^custom-([0-9a-f]{32})-[0-9a-f]{8}$")
CUSTOM_AVATAR_MAX_BYTES = 2 * 1024 * 1024
CUSTOM_AVATAR_TYPES = ("image/png", "image/jpeg", "image/webp")
PBKDF2_ITERATIONS = 120_000
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_SECONDS = 60


class PlayerError(Exception):
    """A request-level failure with an HTTP status and stable error code."""

    def __init__(self, status: int, code: str, message: str, *, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


def normalize_name(raw: str) -> str:
    return re.sub(r"\s+", " ", raw.strip())


def name_key(raw: str) -> str:
    return normalize_name(raw).casefold()


def hash_pin(pin: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ITERATIONS).hex()


def custom_avatar_id(player_id: str) -> str:
    return f"custom-{uuid.UUID(player_id).hex}-{secrets.token_hex(4)}"


def custom_avatar_owner(avatar) -> uuid.UUID | None:
    """The owning player ID of a custom avatar ID, or None for anything else."""
    match = CUSTOM_AVATAR_PATTERN.match(avatar) if isinstance(avatar, str) else None
    return uuid.UUID(match.group(1)) if match else None


def _sniff_image_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decode_custom_avatar(raw) -> tuple[str, bytes]:
    """Validate a ``{contentType, data}`` upload (base64 data) and return its type and bytes."""
    if not isinstance(raw, dict) or not isinstance(raw.get("data"), str) or not raw["data"]:
        raise PlayerError(400, "avatar-image-invalid", "Choose a PNG, JPEG, or WebP image to upload.")
    content_type = raw.get("contentType")
    if content_type not in CUSTOM_AVATAR_TYPES:
        raise PlayerError(415, "avatar-image-type", "Use a PNG, JPEG, or WebP image.")
    if len(raw["data"]) > (CUSTOM_AVATAR_MAX_BYTES * 4) // 3 + 4:
        raise PlayerError(413, "avatar-image-too-large", "Images can be at most 2 MB.")
    try:
        data = base64.b64decode(raw["data"], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PlayerError(400, "avatar-image-invalid", "That image could not be read. Try another file.") from exc
    if len(data) > CUSTOM_AVATAR_MAX_BYTES:
        raise PlayerError(413, "avatar-image-too-large", "Images can be at most 2 MB.")
    if _sniff_image_type(data) != content_type:
        raise PlayerError(400, "avatar-image-invalid", "That image could not be read. Try another file.")
    return content_type, data


@dataclass
class Player:
    id: str
    name: str
    avatar: str
    created_at: float
    last_seen_at: float
    pin_salt: str
    pin_hash: str
    failed_attempts: int = 0
    locked_until: float = 0.0
    tokens: list[str] = field(default_factory=list)
    custom_avatar: str | None = None
    # In-memory store only; PostgreSQL keeps the image in player_custom_avatars.
    custom_avatar_type: str | None = None
    custom_avatar_data: str | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "avatar": self.avatar,
            "customAvatar": self.custom_avatar,
            "createdAt": int(self.created_at * 1000),
            "lastSeenAt": int(self.last_seen_at * 1000),
        }


class PlayerStore:
    def __init__(self, path: str | None = None, *, now=time.time):
        self._path = path
        self._now = now
        self._lock = asyncio.Lock()
        self._players: dict[str, Player] = {}  # name_key -> Player
        self._tokens: dict[str, str] = {}  # token -> name_key
        self._load()

    # -- persistence ---------------------------------------------------------

    def _load(self) -> None:
        if not self._path or not os.path.exists(self._path):
            return
        with open(self._path, encoding="utf-8") as handle:
            data = json.load(handle)
        for record in data.get("players", []):
            # Accounts saved while the avatar shop existed carry an obsolete ownership list.
            record.pop("unlocked_avatars", None)
            player = Player(**record)
            self._players[name_key(player.name)] = player
            for token in player.tokens:
                self._tokens[token] = name_key(player.name)

    def _save(self) -> None:
        if not self._path:
            return
        payload = {"version": 1, "players": [asdict(p) for p in self._players.values()]}
        directory = os.path.dirname(self._path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".players-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, self._path)

    # -- validation ----------------------------------------------------------

    @staticmethod
    def _validate_name(raw) -> str:
        if not isinstance(raw, str) or not normalize_name(raw):
            raise PlayerError(400, "name-blank", "Enter a name to continue.")
        name = normalize_name(raw)
        if len(name) > NAME_MAX_LENGTH:
            raise PlayerError(400, "name-too-long", f"Names can be at most {NAME_MAX_LENGTH} characters.")
        return name

    @staticmethod
    def _validate_pin(raw) -> str:
        if not isinstance(raw, str) or not PIN_PATTERN.match(raw):
            raise PlayerError(400, "pin-invalid", "PIN must be exactly 4 digits.")
        return raw

    @staticmethod
    def _validate_avatar(raw) -> str:
        if raw not in AVATARS:
            raise PlayerError(400, "avatar-invalid", "Choose an avatar to continue.")
        return raw

    # -- operations ----------------------------------------------------------

    def _issue_token(self, player: Player) -> str:
        token = secrets.token_urlsafe(32)
        player.tokens.append(token)
        player.tokens = player.tokens[-10:]  # keep the most recent devices
        self._tokens = {t: k for k, p in self._players.items() for t in p.tokens}
        return token

    @staticmethod
    def _validate_registration_avatar(avatar, custom_image) -> tuple[str, tuple[str, bytes] | None]:
        if avatar == CUSTOM_AVATAR_CHOICE:
            return CUSTOM_AVATAR_CHOICE, decode_custom_avatar(custom_image)
        return PlayerStore._validate_avatar(avatar), None

    async def register(self, name, pin, avatar, custom_image=None) -> tuple[str, Player]:
        clean_name = self._validate_name(name)
        clean_pin = self._validate_pin(pin)
        clean_avatar, image = self._validate_registration_avatar(avatar, custom_image)
        async with self._lock:
            key = name_key(clean_name)
            if key in self._players:
                raise PlayerError(409, "name-taken", "That name is already taken. Choose another or sign in.")
            now = self._now()
            salt = secrets.token_bytes(16)
            player = Player(
                id=uuid.uuid4().hex,
                name=clean_name,
                avatar=clean_avatar,
                created_at=now,
                last_seen_at=now,
                pin_salt=salt.hex(),
                pin_hash=hash_pin(clean_pin, salt),
            )
            if image:
                self._store_custom_avatar(player, *image)
                player.avatar = player.custom_avatar
            self._players[key] = player
            token = self._issue_token(player)
            self._save()
            return token, player

    async def login(self, name, pin) -> tuple[str, Player]:
        clean_name = self._validate_name(name)
        clean_pin = self._validate_pin(pin)
        async with self._lock:
            player = self._players.get(name_key(clean_name))
            now = self._now()
            if player and player.locked_until > now:
                raise PlayerError(
                    429,
                    "locked",
                    "Too many attempts. Try again in a minute.",
                    retry_after=int(player.locked_until - now) + 1,
                )
            valid = player is not None and hmac.compare_digest(
                hash_pin(clean_pin, bytes.fromhex(player.pin_salt)), player.pin_hash
            )
            if not valid:
                if player:
                    player.failed_attempts += 1
                    if player.failed_attempts >= MAX_FAILED_ATTEMPTS:
                        player.failed_attempts = 0
                        player.locked_until = now + LOCKOUT_SECONDS
                    self._save()
                raise PlayerError(401, "invalid-credentials", "That name and PIN don't match.")
            player.failed_attempts = 0
            player.locked_until = 0.0
            player.last_seen_at = now
            token = self._issue_token(player)
            self._save()
            return token, player

    async def authenticate(self, token: str | None) -> Player:
        if not token:
            raise PlayerError(401, "unauthorized", "Sign in to continue.")
        async with self._lock:
            key = self._tokens.get(token)
            player = self._players.get(key) if key else None
            if player is None:
                raise PlayerError(401, "unauthorized", "Your session is no longer valid. Sign in again.")
            player.last_seen_at = self._now()
            self._save()
            return player

    @staticmethod
    def _store_custom_avatar(player: Player, content_type: str, data: bytes) -> None:
        previous = player.custom_avatar
        player.custom_avatar = custom_avatar_id(player.id)
        player.custom_avatar_type = content_type
        player.custom_avatar_data = base64.b64encode(data).decode()
        if previous and player.avatar == previous:
            player.avatar = player.custom_avatar

    async def set_custom_avatar(self, player_id: str, raw) -> Player:
        image = decode_custom_avatar(raw)
        async with self._lock:
            player = next((p for p in self._players.values() if p.id == player_id), None)
            if player is None:
                raise PlayerError(401, "unauthorized", "Your session is no longer valid. Sign in again.")
            self._store_custom_avatar(player, *image)
            self._save()
            return player

    async def custom_avatar_image(self, avatar_id: str) -> tuple[str, bytes] | None:
        owner = custom_avatar_owner(avatar_id)
        player = next((p for p in self._players.values() if owner and uuid.UUID(p.id) == owner), None)
        if player is None or not player.custom_avatar_data:
            return None
        return player.custom_avatar_type, base64.b64decode(player.custom_avatar_data)

    async def logout(self, token: str | None) -> None:
        if not token:
            return
        async with self._lock:
            key = self._tokens.pop(token, None)
            player = self._players.get(key) if key else None
            if player and token in player.tokens:
                player.tokens.remove(token)
                self._save()
