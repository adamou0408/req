-- 比較用：同樣的驗章用 plpython3u + Python cryptography（OpenSSL）實作。
-- 只裝在效能資料庫 sgn_bench，不在執行路徑。plpython3u 是 untrusted 語言：
-- 只有 superuser 能建立 function，function 內可以讀寫資料庫伺服器的檔案與網路。

create extension if not exists plpython3u;

create function sgn_internal.py_es256_verify(p_message bytea, p_der_sig bytea, p_pubkey bytea)
returns boolean
language plpython3u
immutable
strict
as $$
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature
try:
    key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), bytes(p_pubkey))
    key.verify(bytes(p_der_sig), bytes(p_message), ec.ECDSA(hashes.SHA256()))
    return True
except (InvalidSignature, ValueError):
    return False
$$;

create function sgn_internal.py_rs256_verify(p_message bytea, p_sig bytea, p_n bytea, p_e bytea)
returns boolean
language plpython3u
immutable
strict
as $$
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature
key = rsa.RSAPublicNumbers(int.from_bytes(bytes(p_e), 'big'), int.from_bytes(bytes(p_n), 'big')).public_key()
try:
    key.verify(bytes(p_sig), bytes(p_message), padding.PKCS1v15(), hashes.SHA256())
    return True
except InvalidSignature:
    return False
$$;
