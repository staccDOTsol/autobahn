use serde::Deserialize;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};

pub fn serialize_to_file<T>(data: &T, path: &str)
where
    T: Serialize,
{
    let serialized_data = bincode::serialize(&data).unwrap();
    let file_writer = File::create(path).unwrap();
    let mut writer = lz4::EncoderBuilder::new().build(file_writer).unwrap();
    writer.write_all(serialized_data.as_slice()).unwrap();
    writer.flush().unwrap();
    let _ = writer.finish();
}

pub fn deserialize_from_file<T>(path: &String) -> anyhow::Result<T>
where
    for<'a> T: Deserialize<'a>,
{
    let file_reader = File::open(path)?;
    let reader = lz4::Decoder::new(file_reader)?;
    let mut reader = reader.take(512 * 1024 * 1024 + 1);
    let mut data = vec![];
    reader.read_to_end(&mut data)?;
    anyhow::ensure!(data.len() <= 512 * 1024 * 1024, "oversized execution dump");

    let dump: T = bincode::deserialize(data.as_slice())?;
    Ok(dump)
}
