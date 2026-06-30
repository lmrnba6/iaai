# Fee structures for different vehicle types
VEHICLE_FEE_STRUCTURES = {
    'passenger_car': {
        'buyer_premium_rate': 0.10,  # 10%
        'fixed_fees': 200,
        'tax_rate': 0.08  # 8%
    },
    'suv': {
        'buyer_premium_rate': 0.12,  # 12%
        'fixed_fees': 250,
        'tax_rate': 0.08  # 8%
    },
    'light_truck': {
        'buyer_premium_rate': 0.15,  # 15%
        'fixed_fees': 300,
        'tax_rate': 0.08  # 8%
    }
}

# Damage impact on price (as percentage reduction)
DAMAGE_IMPACT = {
    'repossession': 0.05,  # 5% reduction for repossession
    'engine': 0.30,  # 30% reduction for engine damage
    'transmission': 0.25,
    'frame': 0.20,
    'electrical': 0.15,
    'front': 0.12,  # 12% reduction for front end damage
    'cosmetic': 0.10,
    'none': 0.0
}

def calculate_final_price(bid_amount, vehicle_type='passenger_car', primary_damage='repossession', secondary_damage='engine', other_damage='front'):
    """
    Calculate the final price of a vehicle purchase after various fees and damage adjustments.
    
    Args:
        bid_amount (float): The winning bid amount
        vehicle_type (str): Type of vehicle ('passenger_car', 'suv', 'light_truck')
        primary_damage (str): Primary damage type
        secondary_damage (str): Secondary damage type
        other_damage (str): Other damage type
    
    Returns:
        dict: Breakdown of all costs and final total
    """
    # Get vehicle fee structure
    fees = VEHICLE_FEE_STRUCTURES.get(vehicle_type, VEHICLE_FEE_STRUCTURES['passenger_car'])
    fee_percentage = fees['buyer_premium_rate']
    fixed_fee = fees['fixed_fees']
    tax_rate = fees['tax_rate']
    
    # Calculate damage adjustments
    primary_damage_reduction = bid_amount * DAMAGE_IMPACT.get(primary_damage.lower(), 0)
    secondary_damage_reduction = bid_amount * DAMAGE_IMPACT.get(secondary_damage.lower(), 0)
    other_damage_reduction = bid_amount * DAMAGE_IMPACT.get(other_damage.lower(), 0)
    adjusted_bid = bid_amount - primary_damage_reduction - secondary_damage_reduction - other_damage_reduction
    
    # Calculate fees on adjusted bid
    buyer_premium = adjusted_bid * fee_percentage
    subtotal = adjusted_bid + buyer_premium + fixed_fee
    sales_tax = subtotal * tax_rate
    final_total = subtotal + sales_tax
    
    return {
        'vehicle_type': vehicle_type,
        'original_bid': bid_amount,
        'primary_damage': primary_damage,
        'secondary_damage': secondary_damage,
        'other_damage': other_damage,
        'primary_damage_reduction': primary_damage_reduction,
        'secondary_damage_reduction': secondary_damage_reduction,
        'other_damage_reduction': other_damage_reduction,
        'adjusted_bid': adjusted_bid,
        'buyer_premium_rate': fee_percentage,
        'buyer_premium': buyer_premium,
        'fixed_fees': fixed_fee,
        'tax_rate': tax_rate,
        'subtotal': subtotal,
        'sales_tax': sales_tax,
        'final_total': final_total
    }

def get_vehicle_type_input():
    """Get vehicle type selection from user"""
    print("\nSelect Vehicle Type:")
    print("1. Passenger Car")
    print("2. SUV")
    print("3. Light Truck")
    
    while True:
        try:
            choice = input("Enter your choice (1-3): ")
            if choice == '1':
                return 'passenger_car'
            elif choice == '2':
                return 'suv'
            elif choice == '3':
                return 'light_truck'
            else:
                print("Invalid choice. Please enter 1, 2, or 3.")
        except (ValueError, KeyboardInterrupt):
            print("Invalid input. Please enter a number.")

def calculate_all_vehicle_types(bid_amount, primary_damage='repossession', secondary_damage='engine', other_damage='front'):
    """Calculate prices for all three vehicle types"""
    results = {}
    for vehicle_type in ['passenger_car', 'suv', 'light_truck']:
        results[vehicle_type] = calculate_final_price(bid_amount, vehicle_type, primary_damage, secondary_damage, other_damage)
    return results

# Example usage
if __name__ == "__main__":
    bid = 5200
    
    print(f"Car Price Calculation for ${bid:,} bid:")
    print("=" * 60)
    
    # Calculate for all three vehicle types with specified damage types
    results = calculate_all_vehicle_types(bid, 'repossession', 'engine', 'front')
    
    for vehicle_type, result in results.items():
        print(f"\n{vehicle_type.replace('_', ' ').title()}:")
        print(f"  Original Bid: ${result['original_bid']:,.2f}")
        print(f"  Primary Damage (Repossession): -${result['primary_damage_reduction']:,.2f}")
        print(f"  Secondary Damage (Engine): -${result['secondary_damage_reduction']:,.2f}")
        print(f"  Other Damage (Front): -${result['other_damage_reduction']:,.2f}")
        print(f"  Adjusted Bid: ${result['adjusted_bid']:,.2f}")
        print(f"  Buyer's Premium ({result['buyer_premium_rate']*100:.0f}%): ${result['buyer_premium']:,.2f}")
        print(f"  Fixed Fees: ${result['fixed_fees']:,.2f}")
        print(f"  Subtotal: ${result['subtotal']:,.2f}")
        print(f"  Sales Tax ({result['tax_rate']*100:.0f}%): ${result['sales_tax']:,.2f}")
        print(f"  Final Total: ${result['final_total']:,.2f}")
    
    print("\n" + "=" * 60)
    print("Damage Configuration:")
    print("  Primary: Repossession (5% reduction)")
    print("  Secondary: Engine (30% reduction)")
    print("  Other: Front (12% reduction)")
