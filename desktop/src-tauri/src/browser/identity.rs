pub fn resolve_session(
    endpoint_session_id: &str,
    _meta: Option<&serde_json::Value>,
) -> Result<String, String> {
    if endpoint_session_id.is_empty() {
        return Err("SESSION_ID_REQUIRED".into());
    }
    Ok(endpoint_session_id.into())
}
