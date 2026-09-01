output "architecture_contract" {
  description = "Provider-neutral staging contract to be replaced by the selected cloud modules."
  value       = terraform_data.architecture_contract.output
}
