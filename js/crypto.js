/**
 * PwdPal — Deterministic Password Derivation
 * 
 * Uses Web Crypto API (PBKDF2) to derive passwords from:
 *   pattern (grid sequence) + user seed + domain + counter
 * 
 * Zero dependencies. All computation is client-side.
 */

const PwdCrypto = (() => {

    const ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-SHA256
    const HASH_ALGO = 'SHA-256';

    // Character pools for password generation
    const CHAR_POOLS = {
        lowercase: 'abcdefghijklmnopqrstuvwxyz',
        uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        digits: '0123456789',
        symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?'
    };

    /**
     * Encode a string to a Uint8Array (UTF-8)
     */
    function encode(str) {
        return new TextEncoder().encode(str);
    }

    /**
     * Build the master input by combining pattern + seed
     * Pattern is an array of node indices, e.g. [0, 4, 8, 5, 2]
     */
    function buildMasterInput(pattern, userSeed) {
        // Join pattern nodes with separator to avoid collisions
        // e.g. [1,2,3] vs [12,3] — the separator makes them distinct
        const patternStr = pattern.join('-');
        return `${patternStr}:${userSeed}`;
    }

    /**
     * Build the salt from domain + counter
     */
    function buildSalt(domain, counter = 1) {
        return `pwdpal:${domain.toLowerCase().trim()}:${counter}`;
    }

    /**
     * Derive raw bytes using PBKDF2
     * @param {string} masterInput - Combined pattern + seed string
     * @param {string} salt - Combined domain + counter string
     * @param {number} byteLength - Number of bytes to derive
     * @returns {Promise<Uint8Array>} Derived bytes
     */
    async function deriveBytes(masterInput, salt, byteLength = 32) {
        // Import the master input as a CryptoKey
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encode(masterInput),
            'PBKDF2',
            false,
            ['deriveBits']
        );

        // Derive bits using PBKDF2
        const derivedBits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: encode(salt),
                iterations: ITERATIONS,
                hash: HASH_ALGO
            },
            keyMaterial,
            byteLength * 8
        );

        return new Uint8Array(derivedBits);
    }

    /**
     * Convert derived bytes into a password string matching the given rules
     * @param {Uint8Array} bytes - Raw derived bytes
     * @param {Object} rules - Password rules
     * @param {number} rules.length - Desired password length (12-64)
     * @param {boolean} rules.uppercase - Include uppercase letters
     * @param {boolean} rules.digits - Include digits
     * @param {boolean} rules.symbols - Include symbols
     * @returns {string} Generated password
     */
    function bytesToPassword(bytes, rules) {
        const { length = 20, uppercase = true, digits = true, symbols = true } = rules;

        // Build the character pool based on rules
        let pool = CHAR_POOLS.lowercase;
        const requiredChars = [];

        if (uppercase) {
            pool += CHAR_POOLS.uppercase;
        }
        if (digits) {
            pool += CHAR_POOLS.digits;
        }
        if (symbols) {
            pool += CHAR_POOLS.symbols;
        }

        // Use derived bytes to pick characters from the pool.
        // Modular reduction introduces a <0.13%/char bias (≈0.16 bits lost over a
        // 20-char password from a ~129-bit space) — negligible vs. the 600K-iteration
        // PBKDF2 work factor. Documented, not hidden: see how-it-works.html.
        const chars = [];
        for (let i = 0; i < length; i++) {
            const idx = bytes[i % bytes.length] ^ (bytes[(i + 7) % bytes.length] || 0);
            chars.push(pool[idx % pool.length]);
        }

        // Ensure at least one character from each required pool
        // Use specific byte positions to deterministically pick these
        let guaranteeIdx = 0;
        if (uppercase && !chars.some(c => CHAR_POOLS.uppercase.includes(c))) {
            const pos = bytes[0] % length;
            chars[pos] = CHAR_POOLS.uppercase[bytes[1] % CHAR_POOLS.uppercase.length];
        }
        if (digits && !chars.some(c => CHAR_POOLS.digits.includes(c))) {
            const pos = bytes[2] % length;
            chars[pos] = CHAR_POOLS.digits[bytes[3] % CHAR_POOLS.digits.length];
        }
        if (symbols && !chars.some(c => CHAR_POOLS.symbols.includes(c))) {
            const pos = bytes[4] % length;
            chars[pos] = CHAR_POOLS.symbols[bytes[5] % CHAR_POOLS.symbols.length];
        }

        return chars.join('');
    }

    /**
     * Generate a password from the given inputs
     * @param {Object} params
     * @param {number[]} params.pattern - Array of grid node indices
     * @param {string} params.seed - User's personal seed
     * @param {string} params.domain - Site domain
     * @param {number} [params.counter=1] - Version counter
     * @param {Object} [params.rules] - Password formatting rules
     * @returns {Promise<string>} The generated password
     */
    async function generate({ pattern, seed, domain, counter = 1, rules = {} }) {
        if (!pattern || pattern.length < 3) {
            throw new Error('Pattern must connect at least 3 nodes');
        }
        if (!seed || seed.trim().length === 0) {
            throw new Error('A personal seed is required');
        }
        if (!domain || domain.trim().length === 0) {
            throw new Error('A domain is required');
        }

        const masterInput = buildMasterInput(pattern, seed);
        const salt = buildSalt(domain, counter);

        // Derive enough bytes: at least password length, minimum 32
        const pwdLength = rules.length || 20;
        const byteLength = Math.max(pwdLength * 2, 32);

        const bytes = await deriveBytes(masterInput, salt, byteLength);
        return bytesToPassword(bytes, { length: pwdLength, ...rules });
    }

    // Public API
    return { generate };
})();
