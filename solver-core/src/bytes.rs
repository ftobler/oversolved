//! Little-endian byte cursors shared by both flat codecs.
//!
//! Only the *cursor* is shared, not the format. Each solver crate keeps its own
//! `CodecError` (with its own domain variants: bad entity kind vs bad mate
//! kind) and converts from [`Eof`] via `From`, so `r.u32()?` inside a function
//! returning that crate's error type just works.

/// The only failure a cursor read can produce: ran off the end of the buffer.
///
/// Kept as a distinct type rather than a shared error enum so neither crate's
/// domain variants leak into the other's wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Eof;

/// Cursor over a byte slice with little-endian primitive reads.
#[derive(Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], Eof> {
        let end = self.pos.checked_add(n).ok_or(Eof)?;
        if end > self.buf.len() {
            return Err(Eof);
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, Eof> {
        Ok(self.take(1)?[0])
    }

    pub fn u32(&mut self) -> Result<u32, Eof> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn f32(&mut self) -> Result<f32, Eof> {
        let b = self.take(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn f64(&mut self) -> Result<f64, Eof> {
        let b = self.take(8)?;
        Ok(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
}

/// Growable little-endian byte writer.
#[derive(Default)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_each_primitive_width() {
        let mut w = Writer::default();
        w.u8(0xAB);
        w.u32(0xDEAD_BEEF);
        w.f32(1.5);
        w.f64(-2.25);
        let bytes = w.into_bytes();

        let mut r = Reader::new(&bytes);
        assert_eq!(r.u8(), Ok(0xAB));
        assert_eq!(r.u32(), Ok(0xDEAD_BEEF));
        assert_eq!(r.f32(), Ok(1.5));
        assert_eq!(r.f64(), Ok(-2.25));
        assert_eq!(r.u8(), Err(Eof));
    }

    #[test]
    fn take_past_end_is_eof_and_does_not_advance_past_buffer() {
        let mut r = Reader::new(&[1, 2, 3]);
        assert_eq!(r.take(4), Err(Eof));
        // The failed read left the cursor untouched, so the short read still works.
        assert_eq!(r.take(3), Ok(&[1u8, 2, 3][..]));
    }

    #[test]
    fn length_overflow_is_eof_not_a_panic() {
        let mut r = Reader::new(&[1, 2, 3]);
        assert_eq!(r.take(usize::MAX), Err(Eof));
    }
}
